import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffSnapshots, makeShowtimeKey, mergeUnscannedState, normalizeShowtime } from '../src/check-cgv.js';

const config = {
  behavior: { suppressFirstRunNotifications: true, suppressNewTargetInitialNotifications: true },
  targets: [
    {
      id: 'wanted',
      name: 'Wanted',
      enabled: true,
      movieNameIncludes: ['오디세이'],
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
});
