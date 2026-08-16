import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG = new URL('../watch-config.json', import.meta.url);
const DEFAULT_STATE = new URL('../data/state.json', import.meta.url);

export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

export function yyyymmddInKst(offsetDays = 0, now = new Date()) {
  const base = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  base.setDate(base.getDate() + offsetDays);
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function formatDateForMessage(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function makeShowtimeKey(item) {
  return [
    item.theaterCode,
    item.playDate,
    item.movieCode,
    item.movieName,
    item.startTime,
    item.endTime,
    item.totalSeats,
  ].join('|');
}

export function normalizeShowtime(item) {
  return {
    key: makeShowtimeKey(item),
    movieCode: String(item.movieCode || ''),
    movieName: String(item.movieName || ''),
    theaterCode: String(item.theaterCode || ''),
    theaterName: String(item.theaterName || ''),
    playDate: String(item.playDate || ''),
    startTime: String(item.startTime || ''),
    endTime: String(item.endTime || ''),
    totalSeats: Number(item.totalSeats || 0),
    remainingSeats: Number(item.remainingSeats || 0),
  };
}

function includesAll(value, needles = []) {
  const normalizedValue = value.toLocaleLowerCase('ko-KR');
  return needles.every((needle) => normalizedValue.includes(String(needle).toLocaleLowerCase('ko-KR')));
}

function timeInRange(value, from, to) {
  if (!value) return true;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

export function matchesTarget(showtime, target) {
  if (!target.enabled) return false;
  if (target.movieNameIncludes?.length && !includesAll(showtime.movieName, target.movieNameIncludes)) return false;
  if (target.movieCode && showtime.movieCode !== String(target.movieCode)) return false;
  if (target.dateFrom && showtime.playDate < target.dateFrom) return false;
  if (target.dateTo && showtime.playDate > target.dateTo) return false;
  if (!timeInRange(showtime.startTime, target.timeFrom, target.timeTo)) return false;
  if (showtime.remainingSeats < Number(target.minRemainingSeats || 1)) return false;
  return true;
}

export function diffSnapshots(previousState, currentShowtimes, config, nowIso) {
  const previousShowtimes = previousState.showtimes || {};
  const previousTargetDates = previousState.targetDates || {};
  const notifiedEvents = previousState.notifiedEvents || {};
  const firstRun = Object.keys(previousShowtimes).length === 0 && !previousState.lastCheckedAt;
  const events = [];
  const nextShowtimes = {};
  const nextTargetDates = {};

  for (const showtime of currentShowtimes) {
    nextShowtimes[showtime.key] = {
      ...showtime,
      firstSeenAt: previousShowtimes[showtime.key]?.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
    };
  }

  for (const target of config.targets || []) {
    if (!target.enabled) continue;
    const targetFirstRun = !previousTargetDates[target.id];
    const suppressTargetFirstRun = config.behavior?.suppressNewTargetInitialNotifications !== false;
    const shouldNotifyTarget = !(targetFirstRun && suppressTargetFirstRun);
    const targetShowtimes = currentShowtimes.filter((showtime) => matchesTarget(showtime, target));
    const dates = new Set(targetShowtimes.map((showtime) => showtime.playDate));
    nextTargetDates[target.id] = Object.fromEntries([...dates].map((date) => [date, nowIso]));

    if (!firstRun && shouldNotifyTarget && target.notifyOn?.newDate) {
      for (const date of dates) {
        if (!previousTargetDates[target.id]?.[date]) {
          events.push({ type: 'newDate', target, playDate: date, showtimes: targetShowtimes.filter((s) => s.playDate === date) });
        }
      }
    }

    for (const showtime of targetShowtimes) {
      const previous = previousShowtimes[showtime.key];
      if (!firstRun && shouldNotifyTarget && !previous && target.notifyOn?.newShowtime) {
        events.push({ type: 'newShowtime', target, showtime });
      }
      if (!previous) continue;

      const wasSoldOut = Number(previous.remainingSeats || 0) === 0;
      const hasSeatsNow = showtime.remainingSeats > 0;
      if (!firstRun && shouldNotifyTarget && wasSoldOut && hasSeatsNow && target.notifyOn?.seatReopened) {
        events.push({ type: 'seatReopened', target, showtime, previousSeats: 0, currentSeats: showtime.remainingSeats });
      }

      const increased = showtime.remainingSeats > Number(previous.remainingSeats || 0);
      const increaseFromSoldOutOnly = config.behavior?.notifySeatIncreaseFromSoldOutOnly;
      if (
        !firstRun &&
        shouldNotifyTarget &&
        increased &&
        !(wasSoldOut && target.notifyOn?.seatReopened) &&
        target.notifyOn?.seatIncrease &&
        (!increaseFromSoldOutOnly || wasSoldOut)
      ) {
        events.push({
          type: 'seatIncrease',
          target,
          showtime,
          previousSeats: Number(previous.remainingSeats || 0),
          currentSeats: showtime.remainingSeats,
        });
      }
    }
  }

  const dedupedEvents = [];
  for (const event of events) {
    const key = makeEventKey(event);
    if (notifiedEvents[key]) continue;
    dedupedEvents.push({ ...event, eventKey: key });
    notifiedEvents[key] = nowIso;
  }

  const suppressFirstRun = config.behavior?.suppressFirstRunNotifications !== false;
  return {
    events: firstRun && suppressFirstRun ? [] : dedupedEvents,
    nextState: {
      version: 1,
      lastCheckedAt: nowIso,
      showtimes: nextShowtimes,
      targetDates: nextTargetDates,
      notifiedEvents,
    },
  };
}

export function mergeUnscannedState(previousState, nextState, scannedDates) {
  const scanned = new Set(scannedDates);
  const mergedShowtimes = { ...nextState.showtimes };
  const mergedTargetDates = structuredClone(nextState.targetDates || {});

  for (const [key, showtime] of Object.entries(previousState.showtimes || {})) {
    if (!scanned.has(showtime.playDate)) {
      mergedShowtimes[key] = showtime;
    }
  }

  for (const [targetId, dates] of Object.entries(previousState.targetDates || {})) {
    mergedTargetDates[targetId] ||= {};
    for (const [date, seenAt] of Object.entries(dates || {})) {
      if (!scanned.has(date)) {
        mergedTargetDates[targetId][date] = seenAt;
      }
    }
  }

  return {
    ...nextState,
    showtimes: mergedShowtimes,
    targetDates: mergedTargetDates,
  };
}

function makeEventKey(event) {
  if (event.type === 'newDate') return `${event.type}|${event.target.id}|${event.playDate}`;
  const showtimeKey = event.showtime?.key || '';
  if (event.type === 'seatIncrease') return `${event.type}|${event.target.id}|${showtimeKey}|${event.previousSeats}->${event.currentSeats}`;
  if (event.type === 'seatReopened') return `${event.type}|${event.target.id}|${showtimeKey}|${event.currentSeats}`;
  return `${event.type}|${event.target.id}|${showtimeKey}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTimetableForDate(config, playDate) {
  const source = config.source;
  const url = new URL('/api/cgv/timetable', source.baseUrl);
  url.searchParams.set('playDate', playDate);
  url.searchParams.set('theaterCode', source.theaterCode);
  url.searchParams.set('limit', String(source.limit || 200));

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'cgv-yongsan-alert/0.1' },
  });

  if (!response.ok) {
    throw new Error(`CGV API failed for ${playDate}: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(`CGV API returned unsuccessful response for ${playDate}`);
  }

  return (payload.data?.timetable || []).map(normalizeShowtime);
}

function planScanDates(config, previousState) {
  const source = config.source || {};
  const runCount = Number(previousState.runCount || 0) + 1;
  const frequentDays = Number(source.frequentLookaheadDays || source.lookaheadDays || 7);
  const lookaheadDays = Number(source.lookaheadDays || frequentDays);
  const fullScanEveryRuns = Number(source.fullScanEveryRuns || 1);
  const fullScan = fullScanEveryRuns <= 1 || runCount % fullScanEveryRuns === 0;
  const days = fullScan ? lookaheadDays : Math.min(frequentDays, lookaheadDays);

  return {
    runCount,
    fullScan,
    dates: Array.from({ length: days }, (_, offset) => yyyymmddInKst(offset)),
  };
}

async function fetchAllTimetables(config, dates) {
  const results = [];
  for (let offset = 0; offset < dates.length; offset += 1) {
    const playDate = dates[offset];
    const items = await fetchTimetableForDate(config, playDate);
    results.push(...items);
    if (offset < dates.length - 1) await sleep(Number(config.source?.delayMsBetweenDates || 0));
  }
  return results;
}

function eventTitle(event, prefix) {
  const targetName = event.target.name || event.target.id;
  if (event.type === 'test') return `${prefix} 테스트 알림`;
  if (event.type === 'newDate') return `${prefix} ${targetName} ${formatDateForMessage(event.playDate)} 예매 가능일자 추가`;
  if (event.type === 'newShowtime') return `${prefix} ${event.showtime.movieName} ${formatDateForMessage(event.showtime.playDate)} ${event.showtime.startTime} 새 회차`;
  if (event.type === 'seatReopened') return `${prefix} ${event.showtime.movieName} ${event.showtime.startTime} 좌석 재오픈`;
  return `${prefix} ${event.showtime.movieName} ${event.showtime.startTime} 잔여석 증가`;
}

function eventBody(event) {
  if (event.type === 'test') {
    return [
      '정상 동작 확인용 테스트 알림입니다.',
      `대상: ${event.target.name || event.target.id}`,
      `극장: ${event.showtime.theaterName}`,
      `생성 시각: ${new Date().toISOString()}`,
    ].join('\n');
  }

  if (event.type === 'newDate') {
    const lines = event.showtimes
      .slice(0, 20)
      .map((s) => `- ${s.movieName} ${s.startTime}-${s.endTime} 잔여 ${s.remainingSeats}/${s.totalSeats}`);
    return [`대상: ${event.target.name || event.target.id}`, `날짜: ${formatDateForMessage(event.playDate)}`, '', ...lines].join('\n');
  }

  const s = event.showtime;
  return [
    `대상: ${event.target.name || event.target.id}`,
    `영화: ${s.movieName}`,
    `극장: ${s.theaterName}`,
    `일시: ${formatDateForMessage(s.playDate)} ${s.startTime}-${s.endTime}`,
    `잔여석: ${s.remainingSeats}/${s.totalSeats}`,
    event.previousSeats === undefined ? '' : `이전 잔여석: ${event.previousSeats}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function createGitHubIssue(event, config) {
  const github = config.notification?.githubIssue || {};
  if (!github.enabled) return;

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    console.log(`Notification skipped; missing GITHUB_TOKEN or GITHUB_REPOSITORY for ${event.eventKey}`);
    return;
  }

  const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title: eventTitle(event, github.titlePrefix || '[CGV]'),
      body: `${eventBody(event)}\n\nEvent key: \`${event.eventKey}\``,
      labels: github.labels || [],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub issue creation failed: ${response.status} ${text.slice(0, 300)}`);
  }
}

async function notify(events, config) {
  for (const event of events) {
    await createGitHubIssue(event, config);
    console.log(`Notified ${event.type}: ${event.eventKey}`);
  }
}

function createTestEvent(config) {
  const now = new Date();
  const target = (config.targets || []).find((item) => item.enabled) || { id: 'test', name: '테스트' };
  return {
    type: 'test',
    target,
    eventKey: `test|${now.toISOString()}`,
    showtime: {
      movieName: target.name || target.id,
      theaterName: config.source?.theaterName || 'CGV',
      playDate: yyyymmddInKst(0, now),
      startTime: '00:00',
      endTime: '00:00',
      remainingSeats: 1,
      totalSeats: 1,
    },
  };
}

function readJson(pathOrUrl) {
  return JSON.parse(readFileSync(pathOrUrl, 'utf8'));
}

function writeJson(pathOrUrl, value) {
  writeFileSync(pathOrUrl, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  loadDotEnv();
  const configPath = process.env.WATCH_CONFIG || DEFAULT_CONFIG;
  const statePath = process.env.STATE_FILE || DEFAULT_STATE;
  const config = readJson(configPath);
  const previousState = existsSync(statePath) ? readJson(statePath) : { version: 1, showtimes: {}, targetDates: {}, notifiedEvents: {} };

  const nowIso = new Date().toISOString();
  const scan = planScanDates(config, previousState);
  const currentShowtimes = await fetchAllTimetables(config, scan.dates);
  const diff = diffSnapshots(previousState, currentShowtimes, config, nowIso);
  const nextState = mergeUnscannedState(previousState, diff.nextState, scan.dates);
  nextState.runCount = scan.runCount;

  const events = [...diff.events];
  if (process.env.TEST_NOTIFICATION === 'true') {
    events.push(createTestEvent(config));
  }

  console.log(
    `Fetched ${currentShowtimes.length} showtimes across ${scan.dates.length} days (${scan.fullScan ? 'full' : 'frequent'} scan), detected ${events.length} events`,
  );
  await notify(events, config);
  writeJson(statePath, nextState);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
