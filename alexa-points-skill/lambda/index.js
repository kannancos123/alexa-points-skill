'use strict';

const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const APL_DOC = require('./apl/trend.json');

const TIMEZONE = 'Europe/Oslo';
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Events';
const SECRET_NAME = process.env.GOOGLE_SA_SECRET_NAME;
const SECRET_REGION =
  process.env.GOOGLE_SA_SECRET_REGION || process.env.AWS_REGION || 'eu-west-1';

const PERSONS = ['Krish', 'Adith', 'Kamal', 'Amirtha'];
const KIDS = ['Krish', 'Adith'];
const MAX_BAR_HEIGHT = 200;

let sheetsClientPromise = null;

function ensureConfig() {
  if (!SHEET_ID) {
    throw new Error('Missing GOOGLE_SHEET_ID env var');
  }
  if (!SECRET_NAME) {
    throw new Error('Missing GOOGLE_SA_SECRET_NAME env var');
  }
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

async function appendEvent(event) {
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
    range: `${SHEET_TAB}!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

async function readEvents() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A2:F`,
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

function normalizePerson(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  const map = {
    krish: 'Krish',
    krishna: 'Krish',
    adith: 'Adith',
    adit: 'Adith',
    kamal: 'Kamal',
    amirtha: 'Amirtha',
    amrita: 'Amirtha',
  };
  return map[key] || PERSONS.find((p) => p.toLowerCase() === key) || null;
}

function getLast3Days(now) {
  const day0 = now.startOf('day');
  const days = [day0.minus({ days: 2 }), day0.minus({ days: 1 }), day0];
  const dates = days.map((d) => d.toISODate());
  const labels = days.map((d) => d.toFormat('MMM d'));
  return { dates, labels };
}

function buildTotals(events, dates) {
  const totals = {};
  for (const date of dates) {
    totals[date] = {};
    for (const person of PERSONS) {
      totals[date][person] = 0;
    }
  }

  for (const event of events) {
    if (!totals[event.date]) continue;
    const person = normalizePerson(event.person);
    if (!person) continue;
    totals[event.date][person] += event.delta;
  }

  return totals;
}

function buildTrendPayload(dates, labels, totals) {
  const series = PERSONS.map((name) => {
    const values = dates.map((date) => totals[date][name] || 0);
    return { name, values };
  });

  const maxAbs = Math.max(
    1,
    ...series.flatMap((s) => s.values.map((v) => Math.abs(v)))
  );

  const people = series.map((s) => ({
    name: s.name,
    bars: s.values.map((value, idx) => ({
      label: labels[idx],
      value,
      height: Math.round((Math.abs(value) / maxAbs) * MAX_BAR_HEIGHT),
      color: value < 0 ? '#D9480F' : '#2F9E44',
    })),
  }));

  return {
    title: 'Last 3 Days',
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

function supportsAPL(handlerInput) {
  const interfaces = Alexa.getSupportedInterfaces(handlerInput.requestEnvelope);
  return interfaces && interfaces['Alexa.Presentation.APL'];
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
      const slots = intent.slots || {};
      const personSlot = slots.person && slots.person.value;
      const normalizedPerson = normalizePerson(personSlot);
      const deltaSlot = slots.delta && slots.delta.value;
      const deltaOk = Number.isFinite(parseInt(deltaSlot, 10));
      const directionSlot = slots.direction && slots.direction.value;

      const slotStates = {
        person: normalizedPerson
          ? { canUnderstand: 'YES', canFulfill: 'YES' }
          : personSlot
          ? { canUnderstand: 'NO', canFulfill: 'NO' }
          : { canUnderstand: 'MAYBE', canFulfill: 'MAYBE' },
        delta: deltaSlot
          ? deltaOk
            ? { canUnderstand: 'YES', canFulfill: 'YES' }
            : { canUnderstand: 'NO', canFulfill: 'NO' }
          : { canUnderstand: 'MAYBE', canFulfill: 'MAYBE' },
        direction: directionSlot
          ? { canUnderstand: 'YES', canFulfill: 'YES' }
          : { canUnderstand: 'MAYBE', canFulfill: 'MAYBE' },
      };

      const canFulfill = normalizedPerson ? 'YES' : 'MAYBE';
      return buildCanFulfillResponse(canFulfill, slotStates);
    }

    if (intentName === 'SummaryIntent') {
      return buildCanFulfillResponse('YES');
    }

    return buildCanFulfillResponse('NO');
  },
};

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speakOutput =
      'You can add or reduce points for Krish, Adith, Kamal, or Amirtha, or ask for today\'s summary.';
    return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
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

    const rawPerson = getSlotValue(handlerInput, 'person');
    const person = normalizePerson(rawPerson);
    if (!person) {
      const speakOutput = 'Who should I update?';
      return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
    }

    const rawDirection = getSlotValue(handlerInput, 'direction');
    const direction = rawDirection ? rawDirection.toLowerCase() : 'add';
    const rawDelta = getSlotValue(handlerInput, 'delta');
    const amount = Math.max(1, Math.abs(toInt(rawDelta || 1)));
    const negativeWords = ['reduce', 'remove', 'minus', 'subtract', 'deduct', 'take away', 'takeaway'];
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

    await appendEvent(event);

    const events = await readEvents();
    const { dates } = getLast3Days(now);
    const totals = buildTotals(events, dates);
    const todayTotal = totals[now.toISODate()][person] || 0;

    const actionText = delta > 0 ? 'added' : 'reduced';
    const speakOutput = `Okay, ${actionText} ${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'point' : 'points'} for ${person}. ${person} has ${formatPoints(todayTotal)} today.`;

    return handlerInput.responseBuilder.speak(speakOutput).getResponse();
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

    const now = DateTime.now().setZone(TIMEZONE);
    const events = await readEvents();
    const { dates, labels } = getLast3Days(now);
    const totals = buildTotals(events, dates);

    const today = now.toISODate();
    const krishTotal = totals[today]['Krish'] || 0;
    const adithTotal = totals[today]['Adith'] || 0;

    const speakOutput = `Today, Krish has ${formatPoints(krishTotal)} and Adith has ${formatPoints(adithTotal)}.`;

    const responseBuilder = handlerInput.responseBuilder.speak(speakOutput);

    if (supportsAPL(handlerInput)) {
      const payload = buildTrendPayload(dates, labels, totals);
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

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
    );
  },
  handle(handlerInput) {
    const speakOutput =
      'Try saying: add a point for Krish, reduce two points for Adith, or what is today\'s summary.';
    return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent' ||
        Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent')
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
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent'
    );
  },
  handle(handlerInput) {
    const speakOutput =
      'Sorry, I did not catch that. Try saying add a point for Krish or ask for today\'s summary.';
    return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
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
    AdjustPointsIntentHandler,
    SummaryIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();
