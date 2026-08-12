import ical, {
  ICalCalendarMethod,
  ICalEventBusyStatus,
  ICalEventStatus,
} from "ical-generator";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SLOT_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})\|(\d{1,2}):(\d{2})$/;

export const SITE_URL = "https://binhaim.github.io/Talmood-BandScheduler/";

export function normalizeMemberName(value) {
  return String(value || "").normalize("NFC").trim().toLocaleLowerCase("ko-KR");
}

export function memberFeedKey(value) {
  return Buffer.from(normalizeMemberName(value), "utf8").toString("base64url");
}

function itemName(value) {
  return typeof value === "string" ? value : value?.name || "";
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object") return {};
  const keys = Object.keys(raw);
  if (!keys.some((key) => SLOT_KEY_RE.test(key))) return raw;

  const normalized = {};
  for (const key of keys) {
    const sid = raw[key];
    if (typeof sid !== "string") continue;
    (normalized[sid] ||= {})[key] = true;
  }
  return normalized;
}

function linkedMemberIds(config) {
  const linked = new Set();
  for (const group of Object.values(config?.groups || {})) {
    for (const [uid, included] of Object.entries(group?.members || {})) {
      if (included) linked.add(uid);
    }
  }
  for (const members of Object.values(config?.matrix || {})) {
    for (const [uid, included] of Object.entries(members || {})) {
      if (included) linked.add(uid);
    }
  }
  return linked;
}

function slotStartMs(slotKey) {
  const match = SLOT_KEY_RE.exec(slotKey);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 47 || minute < 0 || minute > 59) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
}

function projectUrl(pid) {
  const url = new URL(SITE_URL);
  url.searchParams.set("p", pid);
  return url.toString();
}

export function activeProjectIds(index) {
  return Object.keys(index || {})
    .filter((pid) => index[pid] && !index[pid].trashedAt)
    .sort();
}

export function listLinkedMembers({ index, projects }) {
  const members = new Map();
  for (const pid of activeProjectIds(index)) {
    const config = projects?.[pid]?.config;
    if (!config) continue;
    const people = config.people || {};
    for (const uid of linkedMemberIds(config)) {
      const displayName = itemName(people[uid]).trim();
      const key = normalizeMemberName(displayName);
      if (key && !members.has(key)) members.set(key, displayName);
    }
  }
  return [...members.entries()]
    .map(([key, displayName]) => ({ key, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko") || a.key.localeCompare(b.key));
}

export function buildMemberIntervals({ index, projects, member }) {
  const memberKey = normalizeMemberName(member);
  if (!memberKey) return { displayName: "", intervals: [], memberFound: false };

  let displayName = "";
  const raw = [];

  for (const pid of activeProjectIds(index)) {
    const project = projects?.[pid];
    const config = project?.config;
    if (!config) continue;

    const people = config.people || {};
    for (const uid of linkedMemberIds(config)) {
      const name = itemName(people[uid]).trim();
      if (!displayName && normalizeMemberName(name) === memberKey) displayName = name;
    }

    const schedule = normalizeSchedule(project.schedule);
    const slotMinutes = Number(config.slotMinutes) > 0 ? Number(config.slotMinutes) : 60;
    const projectName = itemName(config.name).trim() || itemName(index[pid]?.name).trim() || pid;

    for (const [sid, slots] of Object.entries(schedule)) {
      if (!config.songs?.[sid] || !slots || typeof slots !== "object") continue;
      const members = config.matrix?.[sid] || {};
      const includesMember = Object.keys(members).some(
        (uid) => members[uid] && normalizeMemberName(itemName(people[uid])) === memberKey,
      );
      if (!includesMember) continue;

      const songName = itemName(config.songs[sid]).trim() || "활동";
      for (const [slotKey, value] of Object.entries(slots)) {
        if (!value) continue;
        const start = slotStartMs(slotKey);
        if (start === null) continue;
        raw.push({
          pid,
          sid,
          start,
          end: start + slotMinutes * 60 * 1000,
          ext: value === "e",
          projectName,
          songName,
        });
      }
    }
  }

  raw.sort((a, b) => a.start - b.start || a.pid.localeCompare(b.pid) || a.sid.localeCompare(b.sid));
  const intervals = [];
  const lastByActivity = new Map();
  for (const slot of raw) {
    const key = `${slot.pid}|${slot.sid}|${slot.ext ? "e" : "i"}`;
    const previous = lastByActivity.get(key);
    if (previous && slot.start <= previous.end) {
      previous.end = Math.max(previous.end, slot.end);
      continue;
    }
    const interval = { ...slot };
    intervals.push(interval);
    lastByActivity.set(key, interval);
  }

  return { displayName, intervals, memberFound: Boolean(displayName) };
}

export function buildMemberCalendar({
  index,
  projects,
  member,
  feedUrl,
  generatedAt = Date.now(),
  fallbackDisplayName = "",
}) {
  const selection = buildMemberIntervals({ index, projects, member });
  const displayName = selection.displayName || String(fallbackDisplayName || "").trim();
  if (!displayName) return null;

  const calendarName = `${displayName} 전체 합주 시간표`;
  const generatedDate = new Date(generatedAt);
  const calendar = ical({
    name: calendarName,
    description: `Talmood 전체 프로젝트 중 ${displayName} 참여 일정`,
    prodId: { company: "Talmood", product: "BandScheduler", language: "KO" },
    method: ICalCalendarMethod.PUBLISH,
    scale: "GREGORIAN",
    ttl: 6 * 60 * 60,
    source: feedUrl,
    url: feedUrl,
  });

  for (const interval of selection.intervals) {
    const url = projectUrl(interval.pid);
    calendar.createEvent({
      id: `all-${interval.pid}-${interval.sid}-${interval.start}@talmood.app`,
      start: new Date(interval.start),
      end: new Date(interval.end),
      stamp: generatedDate,
      lastModified: generatedDate,
      summary: `${interval.songName}${interval.ext ? " (외부)" : ""} · ${interval.projectName}`,
      description: `프로젝트: ${interval.projectName}\n구분: ${interval.ext ? "외부" : "동방"}\n일정 페이지: ${url}`,
      location: interval.ext ? "외부" : "동방",
      url,
      status: ICalEventStatus.CONFIRMED,
      busystatus: ICalEventBusyStatus.BUSY,
    });
  }

  return {
    body: calendar.toString(),
    calendarName,
    displayName,
    eventCount: selection.intervals.length,
  };
}
