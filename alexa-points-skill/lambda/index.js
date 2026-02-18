'use strict';

const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const APL_DOC = require('./apl/trend.json');

const TIMEZONE = 'Europe/Oslo';
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SECRET_NAME = process.env.GOOGLE_SA_SECRET_NAME;
const SECRET_REGION =
  process.env.GOOGLE_SA_SECRET_REGION || process.env.AWS_REGION || 'eu-west-1';
const FAMILIES_TAB = process.env.GOOGLE_FAMILIES_TAB || 'Families';
const EVENTS_TAB_PREFIX = process.env.GOOGLE_EVENTS_TAB_PREFIX || 'Family_';

const MAX_BAR_HEIGHT = 200;
const SPARK_MAX_HEIGHT = 60;
const MAX_KIDS = 6;
const EVENTS_HEADER = [
  'timestamp_iso',
  'date',
  'person',
  'delta',
  'who',
  'note',
];
const FAMILIES_HEADER = ['user_id', 'tab_name', 'kids', 'created_at', 'updated_at'];

let sheetsClientPromise = null;

function ensureConfig() {
  if (!SHEET_ID) {
    throw new Error('Missing GOOGLE_SHEET_ID env var');
  }
  if (!SECRET_NAME) {
    throw new Error('Missing GOOGLE_SA_SECRET_NAME env var');
  }
}

function getUserId(handlerInput) {
  return (
    handlerInput.requestEnvelope.context &&
    handlerInput.requestEnvelope.context.System &&
    handlerInput.requestEnvelope.context.System.user &&
    handlerInput.requestEnvelope.context.System.user.userId
  );
}

function hashUserId(userId) {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 10);
}

function buildFamilyTabName(userId) {
  return `${EVENTS_TAB_PREFIX}${hashUserId(userId)}`;
}

async function getServiceAccountCredentials() {
  const secrets = new AWS.SecretsManager({ region: SECRET_REGION });
  const data = await secrets.getSecretValue({ SecretId: SECRET_NAME }).promise();
  if (!data.SecretString) {
    throw new Error('SecretString not found in Secrets Manager response');
  }

  let creds = null;
  try {
    creds = JSON.parse(data.SecretString);
  } catch (err) {
    throw new Error('SecretString must be valid JSON');
  }

  if (creds.service_account) {
    creds = creds.service_account;
  }

  return creds;
}

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = await getServiceAccountCredentials();
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })();
  }
  return sheetsClientPromise;
}

async function getSheetNames() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties.title',
  });
  const list = res.data.sheets || [];
  return list.map((s) => s.properties.title);
}

async function ensureSheetExists(sheetName) {
  const names = await getSheetNames();
  if (names.includes(sheetName)) return;

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
}

async function ensureHeaderRow(sheetName, header) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1:Z1`,
  });

  const row = res.data.values && res.data.values[0];
  if (!row || row.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1:${String.fromCharCode(64 + header.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  }
}

async function ensureFamiliesSheet() {
  await ensureSheetExists(FAMILIES_TAB);
  await ensureHeaderRow(FAMILIES_TAB, FAMILIES_HEADER);
}

async function ensureEventsSheet(tabName) {
  await ensureSheetExists(tabName);
  await ensureHeaderRow(tabName, EVENTS_HEADER);
}

async function readFamilies() {
  await ensureFamiliesSheet();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${FAMILIES_TAB}!A2:E`,
  });
  const rows = res.data.values || [];
  return rows.map((row, idx) => ({
    rowIndex: idx + 2,
    userId: row[0] || '',
    tabName: row[1] || '',
    kids: row[2] || '',
    createdAt: row[3] || '',
    updatedAt: row[4] || '',
  }));
}

async function getFamilyConfig(handlerInput) {
  const userId = getUserId(handlerInput);
  if (!userId) return null;
  const families = await readFamilies();
  const row = families.find((f) => f.userId === userId);
  if (!row) return null;

  const kids = parseKidsList(row.kids);
  return {
    userId,
    rowIndex: row.rowIndex,
    tabName: row.tabName,
    kids,
  };
}

async function saveFamilyConfig(userId, kids, existingRow) {
  await ensureFamiliesSheet();
  const tabName = existingRow?.tabName || buildFamilyTabName(userId);
  await ensureEventsSheet(tabName);

  const sheets = await getSheetsClient();
  const now = DateTime.now().setZone(TIMEZONE).toISO();
  const kidsValue = kids.join(', ');

  if (existingRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${FAMILIES_TAB}!C${existingRow.rowIndex}:E${existingRow.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[kidsValue, existingRow.createdAt || now, now]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${FAMILIES_TAB}!A:E`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[userId, tabName, kidsValue, now, now]],
      },
    });
  }

  return { tabName, kids };
}

async function appendEvent(event, tabName) {
  const sheets = await getSheetsClient();
  const values = [
    [
      event.timestamp_iso,
      event.date,
      event.person,
      event.delta,
      event.who,
      event.note || '',
    ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

async function readEvents(tabName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A2:F`,
  });

  const rows = res.data.values || [];
  return rows
    .map((row) => ({
      timestamp_iso: row[0] || '',
      date: row[1] || '',
      person: row[2] || '',
      delta: toInt(row[3]),
      who: row[4] || '',
      note: row[5] || '',
    }))
    .filter((row) => row.date && row.person);
}

function toInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSlotValue(handlerInput, slotName) {
  const slot = Alexa.getSlot(handlerInput.requestEnvelope, slotName);
  if (!slot) return null;

  const resolutions = slot.resolutions && slot.resolutions.resolutionsPerAuthority;
  if (resolutions && resolutions.length > 0) {
    for (const res of resolutions) {
      const value = res.values && res.values[0] && res.values[0].value;
      if (value && value.name) return value.name;
    }
  }

  return slot.value || null;
}

function normalizeName(raw) {
  if (!raw) return '';
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

function parseKidsList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((name) => normalizeName(name))
    .filter((name) => name);
}

function parseKidsInput(raw) {
  if (!raw) return [];
  const cleaned = raw
    .replace(/&/g, ' and ')
    .replace(/\s+and\s+/gi, ',')
    .replace(/\s*,\s*/g, ',')
    .trim();

  const names = cleaned
    .split(',')
    .map((name) => normalizeName(name))
    .filter((name) => name);

  const unique = [];
  for (const name of names) {
    if (!unique.find((n) => n.toLowerCase() === name.toLowerCase())) {
      unique.push(name);
    }
  }

  return unique.slice(0, MAX_KIDS);
}

function normalizeKidName(raw, kids) {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/'s$/, '').trim();
  const match = kids.find((k) => k.toLowerCase() === cleaned);
  return match || null;
}

function buildDateSeries(now, dayCount, labelFormat = 'MMM d') {
  const day0 = now.startOf('day');
  const days = [];
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    days.push(day0.minus({ days: i }));
  }
  const dates = days.map((d) => d.toISODate());
  const labels = days.map((d) => d.toFormat(labelFormat));
  return { dates, labels };
}

function buildMonthSeries(now, labelFormat = 'd') {
  const start = now.startOf('month');
  const day0 = now.startOf('day');
  const diffDays = Math.floor(day0.diff(start, 'days').days);
  const days = [];
  for (let i = 0; i <= diffDays; i += 1) {
    days.push(start.plus({ days: i }));
  }
  const dates = days.map((d) => d.toISODate());
  const labels = days.map((d) => d.toFormat(labelFormat));
  return { dates, labels };
}

function buildTotals(events, dates, kids) {
  const totals = {};
  for (const date of dates) {
    totals[date] = {};
    for (const kid of kids) {
      totals[date][kid] = 0;
    }
  }

  for (const event of events) {
    if (!totals[event.date]) continue;
    const kid = normalizeName(event.person);
    if (!totals[event.date][kid]) totals[event.date][kid] = 0;
    totals[event.date][kid] += event.delta;
  }

  return totals;
}

function buildTrendPayload(
  dates,
  labels,
  totals,
  kids,
  title = 'Last 3 Days',
  summaryLabel = 'Today',
  summaryTotals = null,
  rangeLabel = null
) {
  const series = kids.map((name) => {
    const values = dates.map((date) => totals[date][name] || 0);
    return { name, values };
  });

  const maxAbs = Math.max(
    1,
    ...series.flatMap((s) => s.values.map((v) => Math.abs(v)))
  );

  const lastDate = dates[dates.length - 1];
  const fallbackTotals = totals[lastDate] || {};
  const summaryValues = summaryTotals || fallbackTotals;
  const summary = kids.map((name) => {
    const value = summaryValues[name] || 0;
    const display = formatPoints(value);
    return { name, value, display };
  });

  const count = dates.length;
  let barWidth = 18;
  let barSpacing = 6;
  if (count <= 3) {
    barWidth = 18;
    barSpacing = 6;
  } else if (count <= 7) {
    barWidth = 12;
    barSpacing = 4;
  } else if (count <= 14) {
    barWidth = 8;
    barSpacing = 3;
  } else {
    barWidth = 6;
    barSpacing = 2;
  }

  const labelStep = count <= 7 ? 1 : Math.ceil(count / 5);

  const sparkValues = dates.map((date) => {
    let total = 0;
    for (const kid of kids) {
      total += totals[date][kid] || 0;
    }
    return total;
  });
  const sparkMaxAbs = Math.max(1, ...sparkValues.map((v) => Math.abs(v)));
  const sparkWidth = Math.max(4, Math.round(barWidth * 0.7));
  const spark = sparkValues.map((value, idx) => {
    const showLabel = idx % labelStep === 0 || idx === count - 1;
    return {
      value,
      height: Math.round((Math.abs(value) / sparkMaxAbs) * SPARK_MAX_HEIGHT),
      color: value < 0 ? '#D9480F' : '#2F9E44',
      label: showLabel ? labels[idx] : '',
      labelOpacity: showLabel ? 1 : 0,
      width: sparkWidth,
    };
  });

  const people = series.map((s) => ({
    name: s.name,
    bars: s.values.map((value, idx) => {
      const showLabel = idx % labelStep === 0 || idx === count - 1;
      return {
        label: showLabel ? labels[idx] : '',
        labelOpacity: showLabel ? 1 : 0,
        value,
        height: Math.round((Math.abs(value) / maxAbs) * MAX_BAR_HEIGHT),
        color: value < 0 ? '#D9480F' : '#2F9E44',
        width: barWidth,
      };
    }),
  }));

  return {
    title,
    summaryLabel,
    dateLabel: rangeLabel || labels[labels.length - 1],
    barSpacing,
    summary,
    spark,
    people,
  };
}

function formatPoints(value) {
  const abs = Math.abs(value);
  const points = abs === 1 ? 'point' : 'points';
  if (value < 0) {
    return `minus ${abs} ${points}`;
  }
  return `${abs} ${points}`;
}

function joinWithAnd(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function buildFollowUpPrompt() {
  return 'Anything else?';
}

function supportsAPL(handlerInput) {
  const interfaces = Alexa.getSupportedInterfaces(handlerInput.requestEnvelope);
  return interfaces && interfaces['Alexa.Presentation.APL'];
}

function addDynamicKids(responseBuilder, kids) {
  if (!kids || kids.length === 0) return;
  responseBuilder.addDirective({
    type: 'Dialog.UpdateDynamicEntities',
    updateBehavior: 'REPLACE',
    types: [
      {
        name: 'KID_NAME',
        values: kids.map((kid) => ({ name: { value: kid } })),
      },
    ],
  });
}

function buildCanFulfillResponse(canFulfill, slots) {
  const response = {
    canFulfillIntent: {
      canFulfill,
    },
  };

  if (slots) {
    response.canFulfillIntent.slots = slots;
  }

  return response;
}

function promptForKids(handlerInput) {
  const speakOutput =
    'Welcome to points tracking for your kids. State the name of all the kids. For example, say: my kids are Alex, Krish and Jasmine.';
  return handlerInput.responseBuilder
    .speak(speakOutput)
    .reprompt('Please tell me your kids\' names.')
    .getResponse();
}

async function buildSummaryData(tabName, kids, period = 'today') {
  const now = DateTime.now().setZone(TIMEZONE);
  const events = await readEvents(tabName);
  let dates = [];
  let labels = [];
  let title = 'Last 3 Days';
  let summaryLabel = 'Today';
  let rangeLabel = now.toFormat('MMM d');

  if (period === 'week') {
    ({ dates, labels } = buildDateSeries(now, 7, 'EEE'));
    title = 'Last 7 Days';
    summaryLabel = 'This Week';
    rangeLabel = `${now.minus({ days: 6 }).toFormat('MMM d')}–${now.toFormat(
      'MMM d'
    )}`;
  } else if (period === 'month') {
    ({ dates, labels } = buildMonthSeries(now));
    title = 'This Month';
    summaryLabel = 'This Month';
    rangeLabel = now.toFormat('MMMM yyyy');
  } else {
    ({ dates, labels } = buildDateSeries(now, 3));
  }

  const totals = buildTotals(events, dates, kids);
  return { now, dates, labels, totals, title, summaryLabel, rangeLabel };
}

function aggregateTotals(totals, dates, kids) {
  const summary = {};
  for (const kid of kids) {
    summary[kid] = 0;
  }
  for (const date of dates) {
    const dayTotals = totals[date] || {};
    for (const kid of kids) {
      summary[kid] += dayTotals[kid] || 0;
    }
  }
  return summary;
}

function parseSummaryPeriod(raw) {
  if (!raw) return 'today';
  const text = raw.toLowerCase();
  if (text.includes('week')) return 'week';
  if (text.includes('month')) return 'month';
  return 'today';
}

function buildSummarySpeech(period, now, kids, totals, dates) {
  let values = {};

  if (period === 'week') {
    values = aggregateTotals(totals, dates, kids);
    const parts = kids.map((kid) => `${kid} has ${formatPoints(values[kid] || 0)}`);
    return `The weekly summary is ${joinWithAnd(parts)}.`;
  } else if (period === 'month') {
    values = aggregateTotals(totals, dates, kids);
    const parts = kids.map((kid) => `${kid} has ${formatPoints(values[kid] || 0)}`);
    return `The monthly summary is ${joinWithAnd(parts)}.`;
  } else {
    const today = now.toISODate();
    values = totals[today] || {};
    const parts = kids.map((kid) => `${kid} has ${formatPoints(values[kid] || 0)}`);
    return `Today, ${joinWithAnd(parts)}.`;
  }
}

const CanFulfillIntentRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) ===
      'CanFulfillIntentRequest'
    );
  },
  handle(handlerInput) {
    const intent = handlerInput.requestEnvelope.request.intent || {};
    const intentName = intent.name;

    if (intentName === 'AdjustPointsIntent') {
      return buildCanFulfillResponse('YES', {
        person: { canUnderstand: 'MAYBE', canFulfill: 'MAYBE' },
        delta: { canUnderstand: 'YES', canFulfill: 'YES' },
        direction: { canUnderstand: 'YES', canFulfill: 'YES' },
      });
    }

    if (intentName === 'SummaryIntent') {
      return buildCanFulfillResponse('YES', {
        period: { canUnderstand: 'YES', canFulfill: 'YES' },
      });
    }

    if (intentName === 'ConfigureKidsIntent') {
      return buildCanFulfillResponse('YES', {
        kids: { canUnderstand: 'YES', canFulfill: 'YES' },
      });
    }

    return buildCanFulfillResponse('NO');
  },
};

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    ensureConfig();

    const config = await getFamilyConfig(handlerInput);
    if (!config || config.kids.length === 0) {
      return promptForKids(handlerInput);
    }

    const summaryData = await buildSummaryData(config.tabName, config.kids);
    const speakOutput = buildSummarySpeech(
      'today',
      summaryData.now,
      config.kids,
      summaryData.totals,
      summaryData.dates
    );

    const responseBuilder = handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(buildFollowUpPrompt());
    addDynamicKids(responseBuilder, config.kids);

    if (supportsAPL(handlerInput)) {
      const payload = buildTrendPayload(
        summaryData.dates,
        summaryData.labels,
        summaryData.totals,
        config.kids,
        summaryData.title,
        summaryData.summaryLabel,
        null,
        summaryData.rangeLabel
      );
      responseBuilder.addDirective({
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: 'trend',
        document: APL_DOC,
        datasources: { payload },
      });
    }

    return responseBuilder.getResponse();
  },
};

const ConfigureKidsIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'ConfigureKidsIntent'
    );
  },
  async handle(handlerInput) {
    ensureConfig();

    const rawKids = getSlotValue(handlerInput, 'kids');
    const kids = parseKidsInput(rawKids);
    if (kids.length === 0) {
      const speakOutput =
        'Sorry, I did not catch the names. Please say: my kids are ...';
      return handlerInput.responseBuilder
        .speak(speakOutput)
        .reprompt('Please tell me your kids\' names.')
        .getResponse();
    }

    const userId = getUserId(handlerInput);
    const existing = await getFamilyConfig(handlerInput);
    const saved = await saveFamilyConfig(userId, kids, existing);

    const speakOutput = `Great. I will track points for ${joinWithAnd(
      saved.kids
    )}. You can say, add a point for ${saved.kids[0]}.`;

    const responseBuilder = handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(buildFollowUpPrompt());
    addDynamicKids(responseBuilder, saved.kids);
    return responseBuilder.getResponse();
  },
};

const AdjustPointsIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AdjustPointsIntent'
    );
  },
  async handle(handlerInput) {
    ensureConfig();

    const config = await getFamilyConfig(handlerInput);
    if (!config || config.kids.length === 0) {
      return promptForKids(handlerInput);
    }

    const rawPerson = getSlotValue(handlerInput, 'person');
    const person = normalizeKidName(rawPerson, config.kids);
    if (!person) {
      const speakOutput = `Which child should I update? You can say ${joinWithAnd(
        config.kids
      )}.`;
      const responseBuilder = handlerInput.responseBuilder
        .speak(speakOutput)
        .reprompt(speakOutput);
      addDynamicKids(responseBuilder, config.kids);
      return responseBuilder.getResponse();
    }

    const rawDirection = getSlotValue(handlerInput, 'direction');
    const direction = rawDirection ? rawDirection.toLowerCase() : 'add';
    const rawDelta = getSlotValue(handlerInput, 'delta');
    const amount = Math.max(1, Math.abs(toInt(rawDelta || 1)));
    const negativeWords = [
      'reduce',
      'remove',
      'minus',
      'subtract',
      'deduct',
      'take away',
      'takeaway',
    ];
    const isNegative = negativeWords.some((word) => direction.includes(word));
    const delta = isNegative ? -amount : amount;

    const now = DateTime.now().setZone(TIMEZONE);
    const event = {
      timestamp_iso: now.toISO(),
      date: now.toISODate(),
      person,
      delta,
      who: 'Parent',
      note: delta > 0 ? `Added ${amount}` : `Reduced ${amount}`,
    };

    await appendEvent(event, config.tabName);

    const summaryData = await buildSummaryData(config.tabName, config.kids);
    const todayTotals = summaryData.totals[summaryData.now.toISODate()] || {};
    const todayTotal = todayTotals[person] || 0;

    const actionText = delta > 0 ? 'added' : 'reduced';
    const speakOutput = `Okay, ${actionText} ${Math.abs(delta)} ${
      Math.abs(delta) === 1 ? 'point' : 'points'
    } for ${person}. ${person} has ${formatPoints(todayTotal)} today.`;

    const responseBuilder = handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(buildFollowUpPrompt());
    addDynamicKids(responseBuilder, config.kids);

    if (supportsAPL(handlerInput)) {
      const payload = buildTrendPayload(
        summaryData.dates,
        summaryData.labels,
        summaryData.totals,
        config.kids,
        summaryData.title,
        summaryData.summaryLabel,
        null,
        summaryData.rangeLabel
      );
      responseBuilder.addDirective({
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: 'trend',
        document: APL_DOC,
        datasources: { payload },
      });
    }

    return responseBuilder.getResponse();
  },
};

const SummaryIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'SummaryIntent'
    );
  },
  async handle(handlerInput) {
    ensureConfig();

    const config = await getFamilyConfig(handlerInput);
    if (!config || config.kids.length === 0) {
      return promptForKids(handlerInput);
    }

    const rawPeriod = getSlotValue(handlerInput, 'period');
    const period = parseSummaryPeriod(rawPeriod);
    const summaryData = await buildSummaryData(config.tabName, config.kids, period);
    const speakOutput = buildSummarySpeech(
      period,
      summaryData.now,
      config.kids,
      summaryData.totals,
      summaryData.dates
    );

    const responseBuilder = handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(buildFollowUpPrompt());
    addDynamicKids(responseBuilder, config.kids);

    if (supportsAPL(handlerInput)) {
      const summaryTotals =
        period === 'today'
          ? null
          : aggregateTotals(summaryData.totals, summaryData.dates, config.kids);
      const payload = buildTrendPayload(
        summaryData.dates,
        summaryData.labels,
        summaryData.totals,
        config.kids,
        summaryData.title,
        summaryData.summaryLabel,
        summaryTotals,
        summaryData.rangeLabel
      );
      responseBuilder.addDirective({
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: 'trend',
        document: APL_DOC,
        datasources: { payload },
      });
    }

    return responseBuilder.getResponse();
  },
};

const DoneIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      (Alexa.getIntentName(handlerInput.requestEnvelope) === 'DoneIntent' ||
        Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent')
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Okay.')
      .withShouldEndSession(true)
      .getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
    );
  },
  handle(handlerInput) {
    const speakOutput =
      'You can say: my kids are Anna and Ben. Or say: add a point for Anna. Or: today\'s summary. Say done to exit.';
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      (Alexa.getIntentName(handlerInput.requestEnvelope) ===
        'AMAZON.CancelIntent' ||
        Alexa.getIntentName(handlerInput.requestEnvelope) ===
          'AMAZON.StopIntent')
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak('Goodbye.').getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        'AMAZON.FallbackIntent'
    );
  },
  handle(handlerInput) {
    const speakOutput =
      'Sorry, I did not catch that. Try saying add a point, summary, or done.';
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error(`Error handled: ${error.message}`);
    const speakOutput =
      'Sorry, I had trouble doing that. Please check the skill configuration and try again.';
    return handlerInput.responseBuilder.speak(speakOutput).getResponse();
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    CanFulfillIntentRequestHandler,
    LaunchRequestHandler,
    ConfigureKidsIntentHandler,
    AdjustPointsIntentHandler,
    SummaryIntentHandler,
    DoneIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();
