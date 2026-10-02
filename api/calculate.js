import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Exempt from multiple-procedure reduction ──────────────────────────────────
const EXEMPT_CODES = new Set([
  // E&M
  '99202','99203','99204','99205',
  '99212','99213','99214','99215',
  '99222','99223','99231','99024',
  // Eye exams
  '92002','92004','92012','92014',
  // Diagnostics
  '92083','92082','92081','92136','92250','92133','92134','92132',
  '92025','92020','92285','92225','76514','92071',
]);

function isJCode(code) {
  return /^J/i.test(code);
}

function isExempt(code) {
  return EXEMPT_CODES.has(code) || isJCode(code);
}

/**
 * Apply CMS multiple-procedure reduction rules:
 *   1. Sort non-exempt codes by allowed amount descending.
 *   2. 1st → 100%, 2nd → 50%, 3rd+ → 25%.
 *   3. Exempt codes always pay 100%.
 * Returns { adjustedRates, notes }
 */
function applyMultipleProcedureReduction(cptRates) {
  const exempt = [];
  const nonExempt = [];

  for (const [code, rate] of Object.entries(cptRates)) {
    if (rate === null || rate === undefined) continue;
    if (isExempt(code)) {
      exempt.push({ code, rate: Number(rate) });
    } else {
      nonExempt.push({ code, rate: Number(rate) });
    }
  }

  // Sort non-exempt highest-to-lowest
  nonExempt.sort((a, b) => b.rate - a.rate);

  const adjustedRates = {};
  const notes = [];

  // Exempt codes: 100%
  for (const { code, rate } of exempt) {
    adjustedRates[code] = rate;
  }

  // Non-exempt: tiered reduction
  nonExempt.forEach(({ code, rate }, idx) => {
    let multiplier = 1.0;
    if (idx === 0) multiplier = 1.0;
    else if (idx === 1) multiplier = 0.5;
    else multiplier = 0.25;

    const adjusted = +(rate * multiplier).toFixed(2);
    adjustedRates[code] = adjusted;

    if (multiplier < 1.0) {
      notes.push(`${code}: reduced to ${Math.round(multiplier * 100)}% ($${adjusted.toFixed(2)})`);
    }
  });

  return { adjustedRates, notes };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    patientName,
    insurance,
    cptRates,
    stickyNote,
    deductible = 0,
    unknownCodes = [],
    csType = 'coinsurance',
    coinsurancePct = 20,
    copayAmt = 0,
    selfPayItems = [],
    secondaryCoverage = 'none',
    secondaryName = '',
  } = req.body;

  if (!cptRates || Object.keys(cptRates).length === 0) {
    return res.status(400).json({ error: 'No CPT rates provided' });
  }

  // ── Apply multiple-procedure reduction ───────────────────────────────────────
  const { adjustedRates, notes: reductionNotes } = applyMultipleProcedureReduction(cptRates);

  // ── Compute totals deterministically in JS ────────────────────────────────────
  const totalAllowed = Object.values(adjustedRates).reduce((s, v) => s + (v || 0), 0);

  // Self-pay items total (billed 100% to patient regardless)
  const selfPayTotal = (selfPayItems || []).reduce((s, item) => {
    if (!item || item.code === 'NOCHARGE' || item.code === 'RECHECK') return s;
    return s + (Number(item.charge) || 0);
  }, 0);

  // Cost-sharing on insurance portion
  const ded = Number(deductible) || 0;
  let patientCostShare = 0;
  let deductibleApplied = 0;
  let insurancePays = 0;

  if (csType === 'copay') {
    const copay = Number(copayAmt) || 0;
    patientCostShare = copay;
    insurancePays = Math.max(0, totalAllowed - copay);
    deductibleApplied = 0;
  } else {
    // coinsurance
    const pct = Number(coinsurancePct) || 20;
    deductibleApplied = Math.min(ded, totalAllowed);
    const afterDed = Math.max(0, totalAllowed - deductibleApplied);
    const coinsurance = +(afterDed * pct / 100).toFixed(2);
    patientCostShare = +(deductibleApplied + coinsurance).toFixed(2);
    insurancePays = +(totalAllowed - patientCostShare).toFixed(2);
  }

  const patientOwes = +(patientCostShare + selfPayTotal).toFixed(2);

  // Build a summary for Claude to add any narrative notes (sticky note, secondary, etc.)
  // We pass the ALREADY-COMPUTED numbers so Claude just formats and comments.
  const codeLines = Object.entries(adjustedRates)
    .map(([code, rate]) => {
      const orig = cptRates[code];
      const reduced = orig !== undefined && +orig !== +rate;
      return `  ${code}: $${rate.toFixed(2)}${reduced ? ` (reduced from $${Number(orig).toFixed(2)})` : ''}`;
    })
    .join('\n');

  const prompt = `You are a medical billing assistant for Remagin, an ophthalmology practice.

COMPUTED RESULTS (do NOT recalculate — use these exact numbers):
- Insurance: ${insurance}
- Patient: ${patientName || 'Patient'}
- CPT codes with ADJUSTED allowed amounts (multiple-procedure reduction already applied):
${codeLines}
- Total Allowed: $${totalAllowed.toFixed(2)}
- Deductible Applied: $${deductibleApplied.toFixed(2)}
- Insurance Pays: $${insurancePays.toFixed(2)}
- Patient Cost Share (CPT): $${patientCostShare.toFixed(2)}
- Self-Pay Items Total: $${selfPayTotal.toFixed(2)}
- Patient Owes (Total): $${patientOwes.toFixed(2)}
${reductionNotes.length ? `- Reduction notes: ${reductionNotes.join('; ')}` : ''}
${stickyNote ? `\nBenefit note from chart: "${stickyNote}"` : ''}
${unknownCodes.length ? `\nUnknown CPT codes (no rate): ${unknownCodes.join(', ')}` : ''}
${secondaryCoverage !== 'none' ? `\nSecondary insurance (${secondaryName}): coverage = ${secondaryCoverage}` : ''}

Return ONLY this JSON (no extra text):
{
  "patientName": "${patientName || 'Patient'}",
  "insurance": "${insurance}",
  "cptCodes": ${JSON.stringify(Object.keys(adjustedRates))},
  "totalAllowed": ${totalAllowed.toFixed(2)},
  "deductibleApplied": ${deductibleApplied.toFixed(2)},
  "insurancePays": ${insurancePays.toFixed(2)},
  "patientOwes": ${patientOwes.toFixed(2)},
  "notes": "<one sentence: mention any reduction applied, sticky note override, secondary coverage, or unknown codes — blank string if nothing notable>"
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = message.content[0].text;
    return res.status(200).json({ result });
  } catch (err) {
    console.error('Anthropic error:', err);
    return res.status(500).json({ error: err.message || 'AI call failed' });
  }
}