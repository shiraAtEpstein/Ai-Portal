'use strict';

/**
 * Runnable proof that the guard catches the three real failures Shira reported,
 * plus that clean output passes. No test framework needed:  node framework-guard.test.js
 */

const assert = require('assert');
const { validateOutput, generateWithGuard, detectLanguage } = require('./index');

let passCount = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passCount++;
    results.push(`  ok   ${name}`);
  } catch (err) {
    results.push(`  FAIL ${name}\n         ${err.message}`);
  }
}
const has = (report, rule) => report.violations.some(v => v.rule === rule);

(async () => {

  // ---- FAILURE 1: guessed a date not present in the source -----------------
  await test('FAILURE 1 - guessed date is blocked (STYLE §5.2)', async () => {
    const source = 'עסקה 4471. מחיר הדירה: 1,200,000 ש"ח. קונה: משפחת כהן.';
    const draft = 'שלום, החתימה על ההסכם תתקיים ב-13 במאי 2026. בברכה, שירה';
    const r = await validateOutput(draft, {
      channel: 'email', expectedLanguage: 'he',
      profile: { name: 'שירה', he: 'שירה' }, source,
    });
    assert.ok(!r.pass, 'should be blocked');
    assert.ok(has(r, 'unverified-fact'), 'should flag unverified-fact for the date');
  });

  await test('FAILURE 1b - a marked [VERIFY:] date is allowed', async () => {
    const source = 'עסקה 4471. מחיר הדירה: 1,200,000 ש"ח.';
    const draft = 'שלום, החתימה תתקיים ב[VERIFY: מועד חתימה]. בברכה, שירה';
    const r = await validateOutput(draft, {
      channel: 'email', expectedLanguage: 'he',
      profile: { name: 'שירה' }, source,
    });
    assert.ok(!has(r, 'unverified-fact'), 'placeholder must not be flagged');
  });

  await test('FAILURE 1c - a sourced amount is NOT flagged', async () => {
    const source = 'מחיר הדירה: 1,200,000 ש"ח.';
    const draft = 'המחיר הוא 1,200,000 ש"ח כפי שסוכם. בברכה, שירה';
    const r = await validateOutput(draft, {
      channel: 'email', expectedLanguage: 'he', profile: { name: 'שירה' }, source,
    });
    assert.ok(!has(r, 'unverified-fact'), 'a figure present in source must pass');
  });

  // ---- FAILURE 2: signed with a name scraped from the chat -----------------
  await test('FAILURE 2 - wrong signer name is blocked', async () => {
    const draft = 'שלום רב,\nמצורף המסמך המבוקש.\nבברכה,\nצפורה';
    const r = await validateOutput(draft, {
      channel: 'email', expectedLanguage: 'he',
      profile: { name: 'שירה', he: 'שירה' },
    });
    assert.ok(!r.pass, 'should be blocked');
    assert.ok(has(r, 'signature-mismatch'), 'should flag signature-mismatch');
  });

  await test('FAILURE 2b - correct signer passes the signature check', async () => {
    const draft = 'שלום רב,\nמצורף המסמך המבוקש.\nבברכה,\nשירה';
    const r = await validateOutput(draft, {
      channel: 'email', expectedLanguage: 'he', profile: { name: 'שירה' },
    });
    assert.ok(!has(r, 'signature-mismatch'), 'correct signer must not be flagged');
  });

  // ---- FAILURE 3: replied in Hebrew when the profile pins English ----------
  await test('FAILURE 3 - wrong language is blocked (profile override)', async () => {
    const draft = 'שלום, קיבלתי את פנייתך ואטפל בה בהקדם.';
    const r = await validateOutput(draft, {
      channel: 'chat', expectedLanguage: 'en',   // profile: reply English unless user writes Hebrew
      operatorLanguage: 'en', profile: { name: 'Shira' },
    });
    assert.ok(!r.pass, 'should be blocked');
    assert.ok(has(r, 'language-mismatch'), 'should flag language-mismatch');
  });

  await test('FAILURE 3b - matching language passes', async () => {
    const draft = 'Got it, I will take care of this shortly.';
    const r = await validateOutput(draft, {
      channel: 'chat', expectedLanguage: 'match', operatorLanguage: 'en',
      profile: { name: 'Shira' },
    });
    assert.ok(!has(r, 'language-mismatch'), 'en output for en operator must pass');
  });

  // ---- Other hard rules ----------------------------------------------------
  await test('em-dash is blocked everywhere', async () => {
    const r = await validateOutput('The deal — as discussed — closes soon.', { channel: 'chat' });
    assert.ok(has(r, 'em-dash'), 'em-dash must be flagged');
  });

  await test('two Yaakovs - bare "Yaakov" is blocked', async () => {
    const r = await validateOutput('Please send this to Yaakov for filing.', { channel: 'email' });
    assert.ok(has(r, 'two-yaakovs'), 'bare Yaakov must be flagged');
  });

  await test('AI tell phrase is flagged in client output', async () => {
    const r = await validateOutput('I hope this helps! Feel free to ask.', { channel: 'email' });
    assert.ok(has(r, 'banned-phrase') || has(r, 'banned-signoff'), 'AI tell must be flagged');
  });

  await test('clean English email passes fully', async () => {
    const source = 'Deal 4471. Price: 1,200,000 NIS. Signing date: May 13, 2026.';
    const draft =
      'Dear Mr. Cohen,\n\n' +
      'The signing is scheduled for May 13, 2026. The agreed price is 1,200,000 NIS.\n\n' +
      'Best regards,\nShira';
    const r = await validateOutput(draft, {
      channel: 'email', expectedLanguage: 'en', operatorLanguage: 'en',
      profile: { name: 'Shira' }, source,
    });
    assert.ok(r.pass, 'clean, fully-sourced email must pass. Got: ' +
      r.violations.map(v => v.rule).join(', '));
  });

  // ---- Tier 2 critic (mocked) ---------------------------------------------
  await test('critic pass catches an invented fact the regex cannot', async () => {
    const fakeCritic = async () => JSON.stringify({
      violations: [{
        rule: 'invented-fact',
        message: 'The clause "as we agreed by phone" is not in SOURCE.',
        evidence: 'as we agreed by phone', fix: 'Remove or mark [VERIFY:].',
      }],
    });
    const r = await validateOutput('As we agreed by phone, proceeding now.', {
      channel: 'email', expectedLanguage: 'en', operatorLanguage: 'en',
      source: 'Deal 4471.', critic: fakeCritic,
    });
    assert.ok(has(r, 'invented-fact'), 'critic violation must appear');
    assert.ok(r.tier2.ran, 'tier2 must have run');
  });

  // ---- The enforcement loop ------------------------------------------------
  await test('generateWithGuard regenerates until clean', async () => {
    let call = 0;
    const generate = async (feedback) => {
      call++;
      // first attempt: wrong language; second attempt: fixed
      return call === 1 ? 'שלום, אטפל בזה.' : 'Got it, I will handle it.';
    };
    const out = await generateWithGuard(generate, {
      channel: 'chat', expectedLanguage: 'en', operatorLanguage: 'en',
    }, { maxAttempts: 3 });
    assert.ok(out.report.pass, 'final output must pass');
    assert.strictEqual(out.attempt, 2, 'should have taken 2 attempts');
  });

  await test('detectLanguage basic sanity', async () => {
    assert.strictEqual(detectLanguage('שלום עולם'), 'he');
    assert.strictEqual(detectLanguage('hello world'), 'en');
  });

  // ---- report ----
  console.log(results.join('\n'));
  const total = results.length;
  console.log(`\n${passCount}/${total} tests passed.`);
  process.exit(passCount === total ? 0 : 1);
})();
