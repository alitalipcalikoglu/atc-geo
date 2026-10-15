import { readFileSync } from 'node:fs';
import { GeoError } from './errors.js';

/** @typedef {{ types: [string, RegExp][], keepTrunkZero: boolean }} Plan */

/**
 * E.164 normalisation from the calling-code table: strips formatting, resolves the country from
 * the longest matching calling code (or from a given default country for national numbers) and
 * checks the E.164 length rule. For countries with a national plan in `data/phone-plans.json`
 * (Turkey, NANP, the UK, Germany, France, the Netherlands, Spain, Italy, Russia, Kazakhstan,
 * Azerbaijan) the national number must also match one of the plan's number types, which gives
 * `type` (mobile, fixed, toll-free …) and picks the right country among those sharing a calling
 * code. Elsewhere a number with a known calling code and 8 to 15 digits is `valid`, `type` is
 * `unknown`. Whether the subscriber exists is never known.
 */
export class Phone {
  /**
   * @param {import('./reference.js').Reference} ref
   * @param {string} [plansPath]
   */
  constructor(ref, plansPath = new URL('../data/phone-plans.json', import.meta.url).pathname) {
    this.ref = ref;
    /** @type {Map<string, Plan>} by country alpha-2 */
    this.plans = new Map();
    /** @type {Map<string, Plan>} by calling code, for plans shared by every country on the code (NANP) */
    this.codePlans = new Map();
    const file = /** @type {{ plans: { countries?: string[], callingCode?: string, keepTrunkZero?: boolean, types: [string, string][] }[] }} */ (JSON.parse(readFileSync(plansPath, 'utf8')));
    for (const p of file.plans) {
      const plan = { types: p.types.map(([t, re]) => /** @type {[string, RegExp]} */ ([t, new RegExp(re)])), keepTrunkZero: p.keepTrunkZero === true };
      for (const c of p.countries ?? []) this.plans.set(c, plan);
      if (p.callingCode) this.codePlans.set(p.callingCode, plan);
    }
  }

  /** @param {string} country @param {string} callingCode @returns {Plan|undefined} */
  plan(country, callingCode) {
    return this.plans.get(country) ?? this.codePlans.get(callingCode);
  }

  /** Number type under a plan, or null when it matches none. @param {Plan} plan @param {string} national */
  static type(plan, national) {
    return plan.types.find(([, re]) => re.test(national))?.[0] ?? null;
  }

  /**
   * @param {string} input
   * @param {{ country?: string }} [o] Default country for numbers without a + or 00 prefix.
   */
  normalize(input, o = {}) {
    const raw = input.trim();
    if (!raw) throw new GeoError('INVALID_PHONE', 'number is empty');
    let digits = raw.replace(/[\s().\-‐-―]/g, '');
    let international = false;
    if (digits.startsWith('+')) { international = true; digits = digits.slice(1); }
    else if (digits.startsWith('00')) { international = true; digits = digits.slice(2); }
    else if (digits.startsWith('011') && o.country && this.ref.country(o.country)?.callingCodes.includes('1')) { international = true; digits = digits.slice(3); }
    if (!/^\d+$/.test(digits)) throw new GeoError('INVALID_PHONE', 'number contains characters other than digits, spaces, parentheses, dots and dashes');
    let callingCode = '';
    /** @type {string[]} */ let countries = [];
    if (!international) {
      if (!o.country) return { input: raw, e164: null, valid: false, reason: 'no country and no international prefix', type: null, country: null, countries: [], callingCode: null, national: digits };
      const c = this.ref.requireCountry(o.country);
      if (c.callingCodes.length === 0) return { input: raw, e164: null, valid: false, reason: `no calling code for ${c.alpha2}`, type: null, country: c.alpha2, countries: [c.alpha2], callingCode: null, national: digits };
      callingCode = c.callingCodes[0];
      countries = [c.alpha2];
      // Trunk prefix 0 (most plans) is dropped; NANP has none, and in Italy the 0 is part of the number.
      if (digits.startsWith('0') && callingCode !== '1' && !this.plan(c.alpha2, callingCode)?.keepTrunkZero) digits = digits.replace(/^0+/, '');
      // NANP: a national number written with the country code already (1 555 ...) stays as is.
      if (callingCode === '1' && digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
      digits = callingCode + digits;
    } else {
      for (let len = Math.min(this.ref.maxCallingCodeLength, digits.length); len >= 1; len--) {
        const list = this.ref.byCallingCode.get(digits.slice(0, len));
        if (list) { callingCode = digits.slice(0, len); countries = list; break; }
      }
      if (!callingCode) return { input: raw, e164: `+${digits}`, valid: false, reason: 'unknown calling code', type: null, country: null, countries: [], callingCode: null, national: digits };
      // A country given by the caller wins among countries sharing the code (US/CA, RU/KZ, GB/GG/JE/IM).
      if (o.country) { const c = this.ref.country(o.country); if (c && countries.includes(c.alpha2)) countries = [c.alpha2, ...countries.filter((x) => x !== c.alpha2)]; }
    }
    const national = digits.slice(callingCode.length);
    if (digits.length < 8 || digits.length > 15 || national.length < 4) {
      return { input: raw, e164: `+${digits}`, valid: false, reason: 'E.164 numbers have 8 to 15 digits', type: null, country: countries[0] ?? null, countries, callingCode: `+${callingCode}`, national };
    }
    // Among countries sharing the code, the first whose plan accepts the number wins (+7 7xx is Kazakhstan).
    const matched = countries.find((c) => { const p = this.plan(c, callingCode); return p && Phone.type(p, national); });
    if (matched) countries = [matched, ...countries.filter((x) => x !== matched)];
    const country = countries[0] ?? null;
    const plan = country ? this.plan(country, callingCode) : undefined;
    if (!plan) return { input: raw, e164: `+${digits}`, valid: true, reason: null, type: 'unknown', country, countries, callingCode: `+${callingCode}`, national };
    const type = Phone.type(plan, national);
    return { input: raw, e164: `+${digits}`, valid: type !== null, reason: type ? null : `does not match the ${country} numbering plan`, type, country, countries, callingCode: `+${callingCode}`, national };
  }
}
