import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
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
    item.screenName || '',
    item.screenType || '',
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
    screenName: String(item.screenName || item.screenNm || item.auditoriumName || item.auditoriumNm || ''),
    screenType: String(item.screenType || item.screenTypeName || item.screenTypeNm || item.ratingName || item.ratingNm || ''),
    playDate: String(item.playDate || ''),
    startTime: String(item.startTime || ''),
    endTime: String(item.endTime || ''),
    totalSeats: Number(item.totalSeats || 0),
    remainingSeats: Number(item.remainingSeats || 0),
    seats: Array.isArray(item.seats) ? item.seats : undefined,
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

function matchesScreenProfile(showtime, target, config) {
  const screenProfile = target.screenProfile ? config.screenProfiles?.[target.screenProfile] : null;
  if (!screenProfile) return true;
  if (screenProfile.theaterCode && showtime.theaterCode !== String(screenProfile.theaterCode)) return false;

  const screenText = `${showtime.screenName} ${showtime.screenType}`.trim();
  if (screenProfile.screenNameIncludes?.length && screenText) {
    return includesAll(screenText, screenProfile.screenNameIncludes);
  }

  if (screenProfile.totalSeatsIn?.length) {
    return screenProfile.totalSeatsIn.map(Number).includes(showtime.totalSeats);
  }

  return true;
}

function matchesDirectScreenFilters(showtime, target) {
  const screenText = `${showtime.screenName} ${showtime.screenType}`.trim();
  if (target.screenNameIncludes?.length && !includesAll(screenText, target.screenNameIncludes)) return false;
  if (target.totalSeatsIn?.length && !target.totalSeatsIn.map(Number).includes(showtime.totalSeats)) return false;
  return true;
}

export function matchesTarget(showtime, target, config = {}) {
  if (!target.enabled) return false;
  if (target.movieNameIncludes?.length && !includesAll(showtime.movieName, target.movieNameIncludes)) return false;
  if (target.movieCode && showtime.movieCode !== String(target.movieCode)) return false;
  if (!matchesScreenProfile(showtime, target, config)) return false;
  if (!matchesDirectScreenFilters(showtime, target)) return false;
  if (target.dateFrom && showtime.playDate < target.dateFrom) return false;
  if (target.dateTo && showtime.playDate > target.dateTo) return false;
  if (!timeInRange(showtime.startTime, target.timeFrom, target.timeTo)) return false;
  if (showtime.remainingSeats < Number(target.minRemainingSeats || 1)) return false;
  return true;
}

function seatRow(seat) {
  return String(seat.row || seat.seatRow || seat.rowName || seat.seatRowName || '').trim().toUpperCase();
}

function seatNumber(seat) {
  const value = seat.number ?? seat.seatNo ?? seat.seatNumber ?? seat.col ?? seat.column;
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : NaN;
}

function seatIsAvailable(seat) {
  if (typeof seat.available === 'boolean') return seat.available;
  if (typeof seat.isAvailable === 'boolean') return seat.isAvailable;
  if (typeof seat.reserved === 'boolean') return !seat.reserved;
  if (typeof seat.sold === 'boolean') return !seat.sold;

  const state = String(seat.state || seat.status || seat.seatState || seat.SEAT_STATE || '').trim().toUpperCase();
  if (!state) return false;
  return ['Y', 'AVAILABLE', 'FREE', 'EMPTY', 'N'].includes(state);
}

function desiredSeatRanges(target) {
  return target.desiredAdjacentSeats?.ranges || [];
}

export function findDesiredAdjacentSeatPairs(seats = [], target = {}) {
  const availableByRow = new Map();

  for (const seat of seats) {
    if (!seatIsAvailable(seat)) continue;
    const row = seatRow(seat);
    const number = seatNumber(seat);
    if (!row || Number.isNaN(number)) continue;
    if (!availableByRow.has(row)) availableByRow.set(row, new Set());
    availableByRow.get(row).add(number);
  }

  const pairs = [];
  for (const range of desiredSeatRanges(target)) {
    const rows = (range.rows || []).map((row) => String(row).toUpperCase());
    const from = Number(range.from);
    const to = Number(range.to);
    if (!rows.length || Number.isNaN(from) || Number.isNaN(to)) continue;

    for (const row of rows) {
      const numbers = availableByRow.get(row);
      if (!numbers) continue;
      for (let number = from; number < to; number += 1) {
        if (numbers.has(number) && numbers.has(number + 1)) {
          pairs.push({ row, seats: [`${row}${number}`, `${row}${number + 1}`], key: `${row}${number}-${row}${number + 1}` });
        }
      }
    }
  }

  return pairs;
}

export function diffSnapshots(previousState, currentShowtimes, config, nowIso) {
  const previousShowtimes = previousState.showtimes || {};
  const previousTargetDates = previousState.targetDates || {};
  const previousSeatPairs = previousState.seatPairs || {};
  const notifiedEvents = previousState.notifiedEvents || {};
  const firstRun = Object.keys(previousShowtimes).length === 0 && !previousState.lastCheckedAt;
  const events = [];
  const nextShowtimes = {};
  const nextTargetDates = {};
  const nextSeatPairs = {};

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
    const targetShowtimes = currentShowtimes.filter((showtime) => matchesTarget(showtime, target, config));
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

      if (target.notifyOn?.desiredSeatPair && Array.isArray(showtime.seats)) {
        const currentPairs = findDesiredAdjacentSeatPairs(showtime.seats, target);
        const previousPairsForShowtime = previousSeatPairs[showtime.key];
        nextSeatPairs[showtime.key] = Object.fromEntries(currentPairs.map((pair) => [pair.key, nowIso]));

        if (!firstRun && shouldNotifyTarget && previousPairsForShowtime) {
          for (const pair of currentPairs) {
            if (!previousPairsForShowtime[pair.key]) {
              events.push({ type: 'desiredSeatPair', target, showtime, pair });
            }
          }
        }
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
      seatPairs: nextSeatPairs,
      notifiedEvents,
    },
  };
}

export function mergeUnscannedState(previousState, nextState, scannedDates) {
  const scanned = new Set(scannedDates);
  const mergedShowtimes = { ...nextState.showtimes };
  const mergedTargetDates = structuredClone(nextState.targetDates || {});
  const mergedSeatPairs = structuredClone(nextState.seatPairs || {});

  for (const [key, showtime] of Object.entries(previousState.showtimes || {})) {
    if (!scanned.has(showtime.playDate)) {
      mergedShowtimes[key] = showtime;
      if (previousState.seatPairs?.[key] && !mergedSeatPairs[key]) {
        mergedSeatPairs[key] = previousState.seatPairs[key];
      }
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
    seatPairs: mergedSeatPairs,
  };
}

function makeEventKey(event) {
  if (event.type === 'newDate') return `${event.type}|${event.target.id}|${event.playDate}`;
  const showtimeKey = event.showtime?.key || '';
  if (event.type === 'seatIncrease') return `${event.type}|${event.target.id}|${showtimeKey}|${event.previousSeats}->${event.currentSeats}`;
  if (event.type === 'seatReopened') return `${event.type}|${event.target.id}|${showtimeKey}|${event.currentSeats}`;
  if (event.type === 'desiredSeatPair') return `${event.type}|${event.target.id}|${showtimeKey}|${event.pair.key}`;
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
  const forceFullScan = process.env.FORCE_FULL_SCAN === 'true' || process.env.BASELINE_ONLY === 'true';
  const fullScan = forceFullScan || fullScanEveryRuns <= 1 || runCount % fullScanEveryRuns === 0;
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
  if (event.type === 'newShowtime') return `${prefix} ${event.showtime.movieName} ${formatDateForMessage(event.showtime.playDate)} ${event.showtime.startTime} 새 예매 가능 회차`;
  if (event.type === 'desiredSeatPair') return `${prefix} ${event.showtime.movieName} ${event.showtime.startTime} 지정 좌석 연속 2석`;
  if (event.type === 'seatReopened') return `${prefix} ${event.showtime.movieName} ${event.showtime.startTime} 매진 회차 좌석 재오픈`;
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
  const screenLabel = event.target.screenProfile ? ` (${event.target.screenProfile})` : '';
  return [
    `대상: ${event.target.name || event.target.id}`,
    `영화: ${s.movieName}`,
    `극장: ${s.theaterName}`,
    s.screenName || s.screenType ? `상영관: ${[s.screenName, s.screenType].filter(Boolean).join(' ')}` : `상영관: 프로필 매칭${screenLabel}`,
    `일시: ${formatDateForMessage(s.playDate)} ${s.startTime}-${s.endTime}`,
    `잔여석: ${s.remainingSeats}/${s.totalSeats}`,
    event.type === 'desiredSeatPair' ? `좌석: ${event.pair.seats.join(', ')}` : '',
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

function emailRecipients() {
  if (process.env.TEST_NOTIFICATION === 'true') {
    const testRecipients = splitCsv(process.env.TEST_EMAIL_RECIPIENTS);
    if (testRecipients.length > 0) return testRecipients;
  }

  return splitCsv(process.env.EMAIL_RECIPIENTS);
}

function emailProvider() {
  return (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function encodeHeader(value) {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function dotStuff(text) {
  return text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function createSmtpClient({ host, port }) {
  const socket = tls.connect({ host, port, servername: host });
  socket.setEncoding('utf8');

  let buffer = '';
  const pending = [];

  function parseResponses() {
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match || match[2] !== ' ') continue;
      const waiter = pending.shift();
      if (waiter) waiter({ code: Number(match[1]), line });
    }
  }

  socket.on('data', (chunk) => {
    buffer += chunk;
    parseResponses();
  });

  function waitForResponse() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SMTP response timeout')), 15000);
      pending.push((response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  async function expect(expectedCodes, command) {
    if (command) socket.write(`${command}\r\n`);
    const response = await waitForResponse();
    const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    if (!codes.includes(response.code)) {
      throw new Error(`SMTP command failed: ${command || '<greeting>'}: ${response.line}`);
    }
    return response;
  }

  return {
    async send(command, expectedCodes) {
      return expect(expectedCodes, command);
    },
    async greeting() {
      return expect(220);
    },
    end() {
      socket.end();
    },
  };
}

async function sendSmtpEmail({ host, port, user, pass, from, to, subject, text }) {
  const client = createSmtpClient({ host, port });

  try {
    await client.greeting();
    await client.send('EHLO github-actions', 250);
    await client.send('AUTH LOGIN', 334);
    await client.send(Buffer.from(user).toString('base64'), 334);
    await client.send(Buffer.from(pass).toString('base64'), 235);
    await client.send(`MAIL FROM:<${from}>`, 250);
    await client.send(`RCPT TO:<${to}>`, [250, 251]);
    await client.send('DATA', 354);
    await client.send(
      [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${encodeHeader(subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        dotStuff(text),
        '.',
      ].join('\r\n'),
      250,
    );
    await client.send('QUIT', 221);
  } finally {
    client.end();
  }
}

async function sendResendEmail(event, config) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const recipients = emailRecipients();

  if (!apiKey || !from || recipients.length === 0) {
    console.log(`Email skipped; missing RESEND_API_KEY, EMAIL_FROM, or EMAIL_RECIPIENTS for ${event.eventKey}`);
    return;
  }

  const subject = eventTitle(event, config.notification?.githubIssue?.titlePrefix || '[CGV]');
  const text = `${eventBody(event)}\n\nEvent key: ${event.eventKey}`;

  for (const to of recipients) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`Resend email failed for ${to}: ${response.status} ${body.slice(0, 300)}`);
      continue;
    }

    console.log(`Email sent to ${to} for ${event.eventKey}`);
  }
}

async function sendGmailEmail(event, config) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const from = process.env.EMAIL_FROM || user;
  const recipients = emailRecipients();

  if (!user || !pass || recipients.length === 0) {
    console.log(`Gmail skipped; missing GMAIL_USER, GMAIL_APP_PASSWORD, or EMAIL_RECIPIENTS for ${event.eventKey}`);
    return;
  }

  const subject = eventTitle(event, config.notification?.githubIssue?.titlePrefix || '[CGV]');
  const text = `${eventBody(event)}\n\nEvent key: ${event.eventKey}`;

  for (const to of recipients) {
    try {
      await sendSmtpEmail({
        host: 'smtp.gmail.com',
        port: 465,
        user,
        pass,
        from,
        to,
        subject,
        text,
      });
      console.log(`Gmail sent to ${to} for ${event.eventKey}`);
    } catch (error) {
      console.warn(`Gmail failed for ${to}: ${error.message}`);
    }
  }
}

async function sendEmail(event, config) {
  const provider = emailProvider();
  if (provider === 'gmail') {
    await sendGmailEmail(event, config);
    return;
  }

  if (provider === 'resend') {
    await sendResendEmail(event, config);
    return;
  }

  if (process.env.GMAIL_USER || process.env.GMAIL_APP_PASSWORD) {
    await sendGmailEmail(event, config);
    return;
  }

  if (process.env.RESEND_API_KEY) {
    await sendResendEmail(event, config);
    return;
  }

  console.log(`Email skipped; missing email provider settings for ${event.eventKey}`);
}

function kakaoEnabled() {
  return (process.env.KAKAO_ENABLED || '').trim().toLowerCase() === 'true';
}

function kakaoReceiverUuids() {
  return splitCsv(process.env.KAKAO_RECEIVER_UUIDS);
}

function kakaoSendToMeEnabled() {
  return (process.env.KAKAO_SEND_TO_ME || '').trim().toLowerCase() === 'true';
}

async function getKakaoAccessToken() {
  const existingAccessToken = process.env.KAKAO_ACCESS_TOKEN;
  if (existingAccessToken) return existingAccessToken;

  const clientId = process.env.KAKAO_REST_API_KEY;
  const refreshToken = process.env.KAKAO_REFRESH_TOKEN;
  if (!clientId || !refreshToken) return '';

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (process.env.KAKAO_CLIENT_SECRET) {
    body.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
  }

  const response = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    console.warn(`Kakao token refresh failed: ${response.status} ${text.slice(0, 300)}`);
    return '';
  }

  try {
    const payload = JSON.parse(text);
    if (payload.refresh_token) {
      console.warn('Kakao returned a new refresh token; update KAKAO_REFRESH_TOKEN secret manually.');
    }
    return payload.access_token || '';
  } catch {
    console.warn(`Kakao token refresh response parse failed: ${text.slice(0, 120)}`);
    return '';
  }
}

function kakaoTemplateObject(event, config) {
  const title = eventTitle(event, config.notification?.githubIssue?.titlePrefix || '[CGV]');
  const body = eventBody(event).split('\n').filter(Boolean).slice(0, 4).join('\n');
  const repository = process.env.GITHUB_REPOSITORY || '';
  const link = repository ? `https://github.com/${repository}/issues` : 'https://github.com';

  return {
    object_type: 'text',
    text: truncateText(`${title}\n${body}`, 200),
    link: {
      web_url: link,
      mobile_web_url: link,
    },
    button_title: '자세히 보기',
  };
}

async function postKakaoMessage({ accessToken, url, body }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    console.warn(`Kakao message failed: ${response.status} ${text.slice(0, 300)}`);
    return;
  }

  console.log(`Kakao message sent: ${text.slice(0, 300)}`);
}

async function sendKakaoMessage(event, config) {
  if (!kakaoEnabled()) return;

  const receiverUuids = kakaoReceiverUuids();
  const sendToMe = kakaoSendToMeEnabled();
  if (!sendToMe && receiverUuids.length === 0) {
    console.log(`Kakao skipped; missing KAKAO_RECEIVER_UUIDS for ${event.eventKey}`);
    return;
  }

  const accessToken = await getKakaoAccessToken();
  if (!accessToken) {
    console.log(`Kakao skipped; missing KAKAO_ACCESS_TOKEN or KAKAO_REFRESH_TOKEN for ${event.eventKey}`);
    return;
  }

  const templateObject = kakaoTemplateObject(event, config);

  if (sendToMe) {
    const body = new URLSearchParams({
      template_object: JSON.stringify(templateObject),
    });
    await postKakaoMessage({
      accessToken,
      url: 'https://kapi.kakao.com/v2/api/talk/memo/default/send',
      body,
    });
  }

  if (receiverUuids.length > 0) {
    const body = new URLSearchParams({
      receiver_uuids: JSON.stringify(receiverUuids.slice(0, 5)),
      template_object: JSON.stringify(templateObject),
    });
    await postKakaoMessage({
      accessToken,
      url: 'https://kapi.kakao.com/v1/api/talk/friends/message/default/send',
      body,
    });
  }
}

async function notify(events, config) {
  for (const event of events) {
    await createGitHubIssue(event, config);
    await sendEmail(event, config);
    await sendKakaoMessage(event, config);
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

  const events = process.env.BASELINE_ONLY === 'true' ? [] : [...diff.events];
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
