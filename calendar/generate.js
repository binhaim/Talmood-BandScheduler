import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SITE_URL,
  activeProjectIds,
  buildMemberCalendar,
  buildMemberIntervals,
  listLinkedMembers,
  memberFeedKey,
} from "./calendar.js";

const DEFAULT_DATABASE_URL = "https://talmood-timetable-default-rtdb.firebaseio.com";

async function fetchJson(databaseUrl, path, fetchImpl) {
  const url = `${databaseUrl.replace(/\/$/, "")}/${path}.json`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Firebase read failed (${response.status}): ${path}`);
  return response.json();
}

export async function loadScheduleData({
  databaseUrl = DEFAULT_DATABASE_URL,
  fetchImpl = fetch,
} = {}) {
  const index = (await fetchJson(databaseUrl, "projectIndex", fetchImpl)) || {};
  const entries = await Promise.all(
    activeProjectIds(index).map(async (pid) => {
      const [config, schedule] = await Promise.all([
        fetchJson(databaseUrl, `projects/${pid}/config`, fetchImpl),
        fetchJson(databaseUrl, `projects/${pid}/schedule`, fetchImpl),
      ]);
      return [pid, { config, schedule: schedule || {} }];
    }),
  );
  return { index, projects: Object.fromEntries(entries) };
}

function memberFingerprint({ index, projects, member, fallbackDisplayName = "" }) {
  const selection = buildMemberIntervals({ index, projects, member });
  const payload = {
    displayName: selection.displayName || fallbackDisplayName,
    intervals: selection.intervals.map(({ pid, sid, start, end, ext, projectName, songName }) => ({
      pid,
      sid,
      start,
      end,
      ext,
      projectName,
      songName,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
}

function retainedUpdatedAt(previousManifest, feedKey, fingerprint, now) {
  const previous = previousManifest?.feeds?.[feedKey];
  if (previous?.fingerprint === fingerprint && Number.isFinite(previous.updatedAt)) {
    return previous.updatedAt;
  }
  return Math.floor(now / 60000) * 60000;
}

function calendarMembers({ index, projects, previousManifest }) {
  const members = new Map(
    listLinkedMembers({ index, projects }).map(({ displayName }) => [
      memberFeedKey(displayName),
      displayName,
    ]),
  );
  for (const [feedKey, feed] of Object.entries(previousManifest?.feeds || {})) {
    const displayName = String(feed?.displayName || "").trim();
    if (/^[A-Za-z0-9_-]+$/.test(feedKey) && displayName && memberFeedKey(displayName) === feedKey) {
      if (!members.has(feedKey)) members.set(feedKey, displayName);
    }
  }
  return [...members.entries()].sort((a, b) => a[1].localeCompare(b[1], "ko") || a[0].localeCompare(b[0]));
}

export async function generateCalendarFeeds({
  index,
  projects,
  outputDir,
  previousManifest = {},
  now = Date.now(),
  siteUrl = SITE_URL,
}) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const manifest = {
    version: 1,
    builtAt: new Date(now).toISOString(),
    feeds: {},
  };

  for (const [feedKey, displayName] of calendarMembers({ index, projects, previousManifest })) {
    const fingerprint = memberFingerprint({
      index,
      projects,
      member: displayName,
      fallbackDisplayName: displayName,
    });
    const updatedAt = retainedUpdatedAt(previousManifest, feedKey, fingerprint, now);
    const feedUrl = new URL(`calendars/${feedKey}.ics`, siteUrl).toString();
    const calendar = buildMemberCalendar({
      index,
      projects,
      member: displayName,
      feedUrl,
      generatedAt: updatedAt,
      fallbackDisplayName: displayName,
    });
    if (!calendar) continue;

    await writeFile(resolve(outputDir, `${feedKey}.ics`), calendar.body, "utf8");
    manifest.feeds[feedKey] = {
      displayName,
      fingerprint,
      updatedAt,
      eventCount: calendar.eventCount,
    };
  }

  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readPreviousManifest(path) {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function main() {
  const outputDir = resolve(optionValue("--output") || "_site/calendars");
  const previousManifest = await readPreviousManifest(optionValue("--previous"));
  const data = await loadScheduleData({ databaseUrl: process.env.FIREBASE_DATABASE_URL });
  const manifest = await generateCalendarFeeds({ ...data, outputDir, previousManifest });
  console.log(`Generated ${Object.keys(manifest.feeds).length} member calendar feeds.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
