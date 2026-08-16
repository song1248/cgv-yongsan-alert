import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cgvBookingUrl,
  diffSnapshots,
  emailBatchBody,
  emailBatchSubject,
  findDesiredAdjacentSeatPairs,
  makeShowtimeKey,
  mergeUnscannedState,
  normalizeShowtime,
} from '../src/check-cgv.js';

const config = {
  behavior: { suppressFirstRunNotifications: true, suppressNewTargetInitialNotifications: true },
  screenProfiles: {
    'yongsan-imax': {
      theaterCode: '0013',
      totalSeatsIn: [624],
      screenNameIncludes: ['IMAX'],
    },
  },
  targets: [
    {
      id: 'wanted',
      name: 'Wanted',
      enabled: true,
      movieNameIncludes: ['오디세이'],
      ticketAreaCode: '13',
      screenCode: '018',
      minRemainingSeats: 1,
      notifyOn: {
        newDate: true,
        newShowtime: true,
        seatReopened: true,
        seatIncrease: true,
      },
    },
  ],
};

const desiredSeatConfig = {
  ...config,
  targets: [
    {
      ...config.targets[0],
      desiredAdjacentSeats: {
        ranges: [
          { rows: ['H', 'I'], from: 13, to: 31 },
          { rows: ['J', 'K', 'L'], from: 11, to: 34 },
        ],
      },
      notifyOn: {
        newDate: false,
        newShowtime: true,
        seatReopened: false,
        seatIncrease: false,
        desiredSeatPair: true,
      },
    },
  ],
};

function showtime(overrides = {}) {
  return normalizeShowtime({
    movieCode: '30001323',
    movieName: '오디세이',
    theaterCode: '0013',
    theaterName: 'CGV 용산아이파크몰',
    playDate: '20260817',
    startTime: '18:30',
    endTime: '21:32',
    totalSeats: 223,
    remainingSeats: 1,
    ...overrides,
  });
}

describe('diffSnapshots', () => {
  it('suppresses notifications on the first run', () => {
    const result = diffSnapshots({ showtimes: {}, targetDates: {}, notifiedEvents: {} }, [showtime()], config, 'now');
    assert.equal(result.events.length, 0);
  });

  it('detects a new showtime after initialization', () => {
    const previous = {
      lastCheckedAt: 'before',
      showtimes: {},
      targetDates: { wanted: { '20260816': 'before' } },
      notifiedEvents: {},
    };
    const result = diffSnapshots(previous, [showtime()], config, 'now');
    assert.equal(result.events.some((event) => event.type === 'newShowtime'), true);
    assert.equal(result.events.some((event) => event.type === 'newDate'), true);
  });

  it('suppresses existing results when a target is enabled for the first time', () => {
    const current = showtime({ remainingSeats: 3 });
    const previous = {
      lastCheckedAt: 'before',
      showtimes: { [current.key]: { ...current, remainingSeats: 1 } },
      targetDates: {},
      notifiedEvents: {},
    };
    const result = diffSnapshots(previous, [current], config, 'now');
    assert.equal(result.events.length, 0);
  });

  it('detects sold-out to available', () => {
    const current = showtime({ remainingSeats: 4 });
    const key = makeShowtimeKey(current);
    const previous = {
      lastCheckedAt: 'before',
      showtimes: { [key]: { ...current, remainingSeats: 0 } },
      targetDates: { wanted: { '20260817': 'before' } },
      notifiedEvents: {},
    };
    const result = diffSnapshots(previous, [current], config, 'now');
    assert.equal(result.events.some((event) => event.type === 'seatReopened'), true);
    assert.equal(result.events.some((event) => event.type === 'seatIncrease'), false);
  });

  it('preserves unscanned future dates during frequent scans', () => {
    const near = showtime({ playDate: '20260817', startTime: '18:30' });
    const far = showtime({ playDate: '20260827', startTime: '20:00' });
    const previous = {
      showtimes: {
        [near.key]: near,
        [far.key]: far,
      },
      targetDates: {
        wanted: {
          '20260817': 'before',
          '20260827': 'before',
        },
      },
    };
    const next = {
      showtimes: { [near.key]: { ...near, remainingSeats: 2 } },
      targetDates: { wanted: { '20260817': 'now' } },
    };
    const merged = mergeUnscannedState(previous, next, ['20260817']);
    assert.equal(Boolean(merged.showtimes[far.key]), true);
    assert.equal(merged.targetDates.wanted['20260827'], 'before');
  });

  it('matches a screen profile by known seat count when screen name is not present', () => {
    const imaxConfig = {
      ...config,
      targets: [{ ...config.targets[0], screenProfile: 'yongsan-imax' }],
    };
    const imax = showtime({ totalSeats: 624 });
    const standard = showtime({ totalSeats: 223, startTime: '19:00' });
    const previous = {
      lastCheckedAt: 'before',
      showtimes: {},
      targetDates: { wanted: { '20260816': 'before' } },
      notifiedEvents: {},
    };
    const result = diffSnapshots(previous, [imax, standard], imaxConfig, 'now');
    const newShowtimes = result.events.filter((event) => event.type === 'newShowtime');
    assert.equal(newShowtimes.length, 1);
    assert.equal(newShowtimes[0].showtime.totalSeats, 624);
  });

  it('finds desired adjacent seat pairs inside configured ranges only', () => {
    const pairs = findDesiredAdjacentSeatPairs(
      [
        { row: 'H', number: 12, available: true },
        { row: 'H', number: 13, available: true },
        { row: 'H', number: 14, available: true },
        { row: 'H', number: 31, available: true },
        { row: 'H', number: 32, available: true },
        { row: 'J', number: 10, available: true },
        { row: 'J', number: 11, available: true },
        { row: 'J', number: 12, available: true },
        { row: 'K', number: 20, available: false },
        { row: 'K', number: 21, available: true },
      ],
      desiredSeatConfig.targets[0],
    );

    assert.deepEqual(
      pairs.map((pair) => pair.key),
      ['H13-H14', 'J11-J12'],
    );
  });

  it('baselines desired adjacent seat pairs when no previous seat-pair snapshot exists', () => {
    const current = showtime({
      seats: [
        { row: 'J', number: 20, available: true },
        { row: 'J', number: 21, available: true },
      ],
    });
    const previous = {
      lastCheckedAt: 'before',
      showtimes: { [current.key]: { ...current, seats: undefined } },
      targetDates: { wanted: { '20260817': 'before' } },
      notifiedEvents: {},
    };

    const result = diffSnapshots(previous, [current], desiredSeatConfig, 'now');
    assert.equal(result.events.some((event) => event.type === 'desiredSeatPair'), false);
    assert.equal(Boolean(result.nextState.seatPairs[current.key]['J20-J21']), true);
  });

  it('detects newly available desired adjacent seat pairs', () => {
    const current = showtime({
      seats: [
        { row: 'J', number: 20, available: true },
        { row: 'J', number: 21, available: true },
        { row: 'J', number: 22, available: true },
      ],
    });
    const previous = {
      lastCheckedAt: 'before',
      showtimes: { [current.key]: { ...current, seats: undefined } },
      seatPairs: { [current.key]: { 'J20-J21': 'before' } },
      targetDates: { wanted: { '20260817': 'before' } },
      notifiedEvents: {},
    };

    const result = diffSnapshots(previous, [current], desiredSeatConfig, 'now');
    const seatPairEvents = result.events.filter((event) => event.type === 'desiredSeatPair');
    assert.equal(seatPairEvents.length, 1);
    assert.equal(seatPairEvents[0].pair.key, 'J21-J22');
  });

  it('builds current CGV movie booking links with theater query', () => {
    const event = {
      type: 'newShowtime',
      target: desiredSeatConfig.targets[0],
      showtime: showtime({ theaterCode: '0013', playDate: '20260817' }),
    };

    assert.equal(
      cgvBookingUrl(event),
      'https://cgv.co.kr/cnm/movieBook/cinema?siteNm=%EC%9A%A9%EC%82%B0%EC%95%84%EC%9D%B4%ED%8C%8C%ED%81%AC%EB%AA%B0',
    );
  });

  it('combines multiple events into one email message', () => {
    const first = {
      type: 'newShowtime',
      target: desiredSeatConfig.targets[0],
      eventKey: 'newShowtime|1',
      showtime: showtime({ playDate: '20260817', startTime: '18:30' }),
    };
    const second = {
      type: 'desiredSeatPair',
      target: desiredSeatConfig.targets[0],
      eventKey: 'desiredSeatPair|1',
      showtime: showtime({ playDate: '20260817', startTime: '20:00' }),
      pair: { seats: ['H13', 'H14'] },
    };

    const subject = emailBatchSubject([first, second], { notification: { githubIssue: { titlePrefix: '[CGV 용산]' } } });
    const body = emailBatchBody([first, second]);

    assert.equal(subject, '[CGV 용산] 알림 2건 (새 회차 1, 원하는 좌석 1)');
    assert.match(body, /알림 2건이 한 번에 감지되었습니다/);
    assert.match(body, /1\. 새 회차/);
    assert.match(body, /2\. 원하는 좌석/);
    assert.match(body, /좌석: H13, H14/);
  });
});
