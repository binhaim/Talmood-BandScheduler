import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ICAL from "ical.js";
import {
  buildMemberCalendar,
  buildMemberIntervals,
  listLinkedMembers,
  memberFeedKey,
  normalizeMemberName,
} from "./calendar.js";
import { generateCalendarFeeds } from "./generate.js";

const index = {
  ACTIVE1: { name: "첫 프로젝트", createdAt: 1 },
  ACTIVE2: { name: "둘째 프로젝트", createdAt: 2 },
  TRASHED: { name: "휴지통 프로젝트", trashedAt: 3 },
};

const projects = {
  ACTIVE1: {
    config: {
      name: "첫 프로젝트",
      slotMinutes: 60,
      people: {
        u1: { name: "김혜원" },
        u2: { name: "다른 멤버" },
        idle: { name: "미연결 멤버" },
      },
      groups: { g1: { members: { u1: true, u2: true } } },
      songs: { s1: { name: "첫 곡" }, s2: { name: "다른 곡" } },
      matrix: { s1: { u1: true }, s2: { u2: true } },
    },
    schedule: {
      s1: {
        "2026-08-13|13:00": true,
        "2026-08-13|14:00": true,
        "2026-08-13|18:00": "e",
      },
      s2: { "2026-08-13|16:00": true },
    },
  },
  ACTIVE2: {
    config: {
      name: "둘째 프로젝트",
      slotMinutes: 30,
      people: { another: { name: "김혜원" } },
      groups: { g2: { members: { another: true } } },
      songs: { late: { name: "심야 곡" } },
      matrix: { late: { another: true } },
    },
    schedule: { late: { "2026-08-13|25:00": true, "2026-08-13|25:30": true } },
  },
  TRASHED: {
    config: {
      name: "휴지통 프로젝트",
      people: { u1: { name: "김혜원" } },
      songs: { gone: { name: "삭제된 곡" } },
      matrix: { gone: { u1: true } },
    },
    schedule: { gone: { "2026-08-13|12:00": true } },
  },
};

test("normalizes member names without exposing case differences", () => {
  assert.equal(normalizeMemberName("  김혜원  "), "김혜원");
  assert.equal(normalizeMemberName("ALICE"), "alice");
  assert.equal(memberFeedKey(" ALICE "), "YWxpY2U");
  assert.match(memberFeedKey("김혜원"), /^[A-Za-z0-9_-]+$/);
});

test("lists only linked members from active projects", () => {
  assert.deepEqual(
    listLinkedMembers({ index, projects }).map((member) => member.displayName),
    ["김혜원", "다른 멤버"],
  );
});

test("collects only the selected member's active-project intervals", () => {
  const result = buildMemberIntervals({ index, projects, member: "김혜원" });
  assert.equal(result.memberFound, true);
  assert.equal(result.displayName, "김혜원");
  assert.equal(result.intervals.length, 3);
  assert.deepEqual(
    result.intervals.map((event) => [event.songName, event.ext, event.end - event.start]),
    [
      ["첫 곡", false, 2 * 60 * 60 * 1000],
      ["첫 곡", true, 60 * 60 * 1000],
      ["심야 곡", false, 60 * 60 * 1000],
    ],
  );
  assert.equal(result.intervals.some((event) => event.songName === "삭제된 곡"), false);
  assert.equal(result.intervals.some((event) => event.songName === "다른 곡"), false);
});

test("generates a parseable UTC subscription calendar", () => {
  const result = buildMemberCalendar({
    index,
    projects,
    member: "김혜원",
    feedUrl: "https://example.com/memberCalendar?member=%EA%B9%80%ED%98%9C%EC%9B%90",
    generatedAt: Date.UTC(2026, 7, 12, 0, 0),
  });
  assert.ok(result);
  assert.equal(result.eventCount, 3);
  assert.doesNotMatch(result.body, /다른 멤버|미연결 멤버|삭제된 곡/);

  const calendar = new ICAL.Component(ICAL.parse(result.body));
  assert.equal(calendar.getFirstPropertyValue("x-wr-calname"), "김혜원 전체 합주 시간표");
  const events = calendar.getAllSubcomponents("vevent").map((component) => new ICAL.Event(component));
  assert.equal(events.length, 3);
  assert.equal(events[0].summary, "첫 곡 · 첫 프로젝트");
  assert.equal(events[0].startDate.toJSDate().toISOString(), "2026-08-13T04:00:00.000Z");
  assert.equal(events[0].endDate.toJSDate().toISOString(), "2026-08-13T06:00:00.000Z");
  assert.equal(events[1].location, "외부");
  assert.equal(events[2].startDate.toJSDate().toISOString(), "2026-08-13T16:00:00.000Z");
});

test("returns an empty feed for a linked member with no assigned events", () => {
  const result = buildMemberCalendar({
    index: { ACTIVE1: index.ACTIVE1 },
    projects: {
      ACTIVE1: {
        ...projects.ACTIVE1,
        config: {
          ...projects.ACTIVE1.config,
          groups: { g1: { members: { idle: true } } },
        },
      },
    },
    member: "미연결 멤버",
    feedUrl: "https://example.com/feed.ics?member=idle",
    generatedAt: 0,
  });
  assert.ok(result);
  assert.equal(result.eventCount, 0);
});

test("returns null when the member does not exist in active projects", () => {
  assert.equal(
    buildMemberCalendar({ index, projects, member: "없는 사람", feedUrl: "https://example.com/feed" }),
    null,
  );
});

test("keeps unchanged feed metadata stable and advances it after schedule changes", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "talmood-feeds-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "talmood-feeds-second-"));
  const changedDir = await mkdtemp(join(tmpdir(), "talmood-feeds-changed-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "talmood-feeds-empty-"));
  const firstNow = Date.UTC(2026, 7, 12, 1, 2, 45);
  const secondNow = Date.UTC(2026, 7, 12, 2, 3, 10);

  const first = await generateCalendarFeeds({ index, projects, outputDir: firstDir, now: firstNow });
  const key = memberFeedKey("김혜원");
  const firstBody = await readFile(join(firstDir, `${key}.ics`), "utf8");
  assert.equal(Object.keys(first.feeds).length, 2);
  assert.equal(first.feeds[key].eventCount, 3);

  const second = await generateCalendarFeeds({
    index,
    projects,
    outputDir: secondDir,
    previousManifest: first,
    now: secondNow,
  });
  const secondBody = await readFile(join(secondDir, `${key}.ics`), "utf8");
  assert.equal(second.feeds[key].updatedAt, first.feeds[key].updatedAt);
  assert.equal(secondBody, firstBody);

  const changedProjects = structuredClone(projects);
  changedProjects.ACTIVE1.config.songs.s1.name = "수정된 첫 곡";
  const changed = await generateCalendarFeeds({
    index,
    projects: changedProjects,
    outputDir: changedDir,
    previousManifest: second,
    now: secondNow,
  });
  const changedBody = await readFile(join(changedDir, `${key}.ics`), "utf8");
  assert.equal(changed.feeds[key].updatedAt, Math.floor(secondNow / 60000) * 60000);
  assert.notEqual(changedBody, firstBody);
  assert.match(changedBody, /수정된 첫 곡/);

  const emptied = await generateCalendarFeeds({
    index: {},
    projects: {},
    outputDir: emptyDir,
    previousManifest: changed,
    now: secondNow + 60000,
  });
  const emptyBody = await readFile(join(emptyDir, `${key}.ics`), "utf8");
  const emptyCalendar = new ICAL.Component(ICAL.parse(emptyBody));
  assert.equal(emptied.feeds[key].displayName, "김혜원");
  assert.equal(emptied.feeds[key].eventCount, 0);
  assert.equal(emptyCalendar.getFirstPropertyValue("x-wr-calname"), "김혜원 전체 합주 시간표");
  assert.equal(emptyCalendar.getAllSubcomponents("vevent").length, 0);
});
