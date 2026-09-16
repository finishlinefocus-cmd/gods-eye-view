import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROFILE_FIELDS,
  PROFILE_LIMITS,
  cleanText,
  findSavedPlace,
  isValidPin,
  mergeProfileFields,
  newPlaceId,
  normalizeProfileName,
  profileNameKey,
  sanitizeCamera,
  sanitizeProfileFields,
  sanitizeProfileUpdate,
} from './schema.js';

test('names are trimmed, control-stripped, capped at 32 and keyed case-insensitively', () => {
  assert.equal(normalizeProfileName('  Sterling\u0000  R  '), 'Sterling R');
  assert.equal(
    normalizeProfileName('x'.repeat(50)).length,
    PROFILE_LIMITS.nameMax,
  );
  assert.equal(profileNameKey('  STERLING '), 'sterling');
  assert.equal(profileNameKey('Sterling'), profileNameKey('sTERLING'));
  assert.equal(normalizeProfileName(null), '');
  assert.equal(cleanText('a\u200bb\u202ec', 10), 'abc');
});

test('PIN must be 4-8 digits', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('12345678'), true);
  assert.equal(isValidPin(1234), true);
  assert.equal(isValidPin('123'), false);
  assert.equal(isValidPin('123456789'), false);
  assert.equal(isValidPin('12a4'), false);
  assert.equal(isValidPin(''), false);
});

test('cameras are range-checked and rounded; optional parts stay optional', () => {
  assert.deepEqual(sanitizeCamera({ lat: '35.1234567', lon: -85 }), {
    lat: 35.123457,
    lon: -85,
  });
  assert.deepEqual(
    sanitizeCamera({
      lat: 1,
      lon: 2,
      height: 100,
      heading: -90,
      pitch: -200,
      roll: 5,
    }),
    { lat: 1, lon: 2, height: 100, heading: 270, pitch: -90, roll: 5 },
  );
  assert.throws(() => sanitizeCamera({ lat: 95, lon: 0 }), /lat\/lon/);
  assert.throws(() => sanitizeCamera({ lon: 0 }), /lat\/lon/);
  assert.throws(() => sanitizeCamera(null), /object/);
});

test('sanitizeProfileUpdate accepts only the known fields, stamps each one, and rejects unknown keys', () => {
  const { fields, fieldUpdatedAt } = sanitizeProfileUpdate(
    {
      savedPlaces: [
        {
          id: 'a1',
          name: 'Office',
          lat: 1,
          lon: 2,
          note: '  desk  ',
          createdAt: 5,
        },
        { id: 'a1', name: 'Dup', lat: 1, lon: 2 },
      ],
      favoriteLayers: ['flights', 'flights', ' satellites '],
      defaultStyle: 'nvg',
      voice: { mode: 'openai' },
      displayName: 'S',
      roomName: null,
      homeView: null,
      atcFavorites: ['KSFO'],
      theme: 'amber',
      updatedAt: 1,
      fieldUpdatedAt: { defaultStyle: 500, theme: 999_999_999_999_999 },
      name: 'ignored (read only)',
      id: 'ignored',
      devices: 9,
    },
    { now: 1000 },
  );
  assert.deepEqual(Object.keys(fields).sort(), [...PROFILE_FIELDS].sort());
  assert.deepEqual(fields.savedPlaces, [
    { id: 'a1', name: 'Office', lat: 1, lon: 2, note: 'desk', createdAt: 5 },
  ]);
  assert.deepEqual(fields.favoriteLayers, ['flights', 'satellites']);
  assert.equal(fields.roomName, null);
  assert.equal(fieldUpdatedAt.defaultStyle, 500);
  assert.equal(fieldUpdatedAt.theme, 1000, 'future stamps are clamped to now');
  assert.equal(fieldUpdatedAt.savedPlaces, 1000);
  assert.throws(
    () => sanitizeProfileUpdate({ openaiKey: 'x' }),
    /unknown profile field: openaiKey/,
  );
  assert.throws(
    () => sanitizeProfileUpdate({ voice: { mode: 'siri' } }),
    /voice\.mode/,
  );
  assert.throws(() => sanitizeProfileUpdate('nope'), /JSON object/);
  assert.throws(
    () =>
      sanitizeProfileUpdate({ savedPlaces: [{ id: 'x', name: 'n', lat: 1 }] }),
    /lat\/lon/,
  );
});

test('mergeProfileFields is last-write-wins per field', () => {
  const current = {
    fields: { defaultStyle: 'nvg', favoriteLayers: ['flights'] },
    fieldUpdatedAt: { defaultStyle: 100, favoriteLayers: 100 },
  };
  const merged = mergeProfileFields(current, {
    fields: {
      defaultStyle: 'thermal',
      favoriteLayers: ['ships'],
      theme: 'amber',
    },
    fieldUpdatedAt: { defaultStyle: 99, favoriteLayers: 100, theme: 50 },
  });
  assert.equal(merged.fields.defaultStyle, 'nvg', 'older stamp loses');
  assert.deepEqual(
    merged.fields.favoriteLayers,
    ['ships'],
    'equal stamp: incoming wins',
  );
  assert.equal(merged.fields.theme, 'amber', 'unset field accepts any stamp');
  assert.deepEqual(merged.applied, ['favoriteLayers', 'theme']);
  assert.deepEqual(merged.fields.savedPlaces, [], 'defaults are filled in');
});

test('sanitizeProfileFields degrades malformed cached fields instead of throwing', () => {
  const out = sanitizeProfileFields({
    savedPlaces: 'garbage',
    favoriteLayers: ['flights'],
    voice: { mode: 'local' },
    homeView: { camera: { lat: 1, lon: 2 } },
    bogus: 1,
  });
  assert.deepEqual(out.savedPlaces, []);
  assert.deepEqual(out.favoriteLayers, ['flights']);
  assert.deepEqual(out.voice, { mode: 'local' });
  assert.deepEqual(out.homeView, { camera: { lat: 1, lon: 2 } });
  assert.equal('bogus' in out, false);
});

test('findSavedPlace matches spoken names exactly, then by containment, longest first', () => {
  const places = [
    { id: '1', name: 'Office' },
    { id: '2', name: 'Office roof' },
    { id: '3', name: "Grandma's house" },
    { id: '4', name: 'The Lab' },
    { id: '5', name: '' },
  ];
  assert.equal(findSavedPlace(places, 'office')?.id, '1');
  assert.equal(findSavedPlace(places, 'the office roof')?.id, '2');
  assert.equal(findSavedPlace(places, 'take me to the office roof')?.id, '2');
  assert.equal(findSavedPlace(places, 'grandmas house')?.id, '3');
  assert.equal(findSavedPlace(places, 'lab')?.id, '4');
  assert.equal(findSavedPlace(places, 'Paris'), null);
  assert.equal(
    findSavedPlace(places, 'of'),
    null,
    'too short to match by containment',
  );
  assert.equal(findSavedPlace([], 'office'), null);
  assert.equal(findSavedPlace(places, ''), null);
});

test('place ids are url-safe', () => {
  const id = newPlaceId(
    () => 0.5,
    () => 1_700_000_000_000,
  );
  assert.match(id, /^p[a-z0-9]+$/);
});
