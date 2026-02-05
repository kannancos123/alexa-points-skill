'use strict';

const AWS = require('aws-sdk');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const PROACTIVE_API_URL = 'https://api.amazonalexa.com/v1/proactive/campaigns';

const HOME_CARD_LOCALE = process.env.HOME_CARD_LOCALE || 'en-US';
const HOME_CARD_SKILL_ID = process.env.HOME_CARD_SKILL_ID;
const HOME_CARD_IMAGE_URL = process.env.HOME_CARD_IMAGE_URL;
const HOME_CARD_SECRET_NAME = process.env.HOME_CARD_SECRET_NAME;
const HOME_CARD_SECRET_REGION =
  process.env.HOME_CARD_SECRET_REGION || process.env.AWS_REGION || 'us-east-1';
const HOME_CARD_TARGETING = process.env.HOME_CARD_TARGETING || 'USERS';
const HOME_CARD_USER_ID = process.env.HOME_CARD_USER_ID;
const HOME_CARD_EXPIRY_HOURS = parseInt(
  process.env.HOME_CARD_EXPIRY_HOURS || '48',
  10
);

const HOME_CARD_HEADER = process.env.HOME_CARD_HEADER || 'Family Points';
const HOME_CARD_PRIMARY =
  process.env.HOME_CARD_PRIMARY || "Tap for today's summary";
const HOME_CARD_SECONDARY =
  process.env.HOME_CARD_SECONDARY || 'Krish • Adith • Kamal • Amirtha';
const HOME_CARD_ATTRIBUTION =
  process.env.HOME_CARD_ATTRIBUTION || 'Daily tracker';
const HOME_CARD_HINT =
  process.env.HOME_CARD_HINT || 'Try "{WakeWord}, points today"';

function assertConfig() {
  const missing = [];
  if (!HOME_CARD_SKILL_ID) missing.push('HOME_CARD_SKILL_ID');
  if (!HOME_CARD_IMAGE_URL) missing.push('HOME_CARD_IMAGE_URL');
  if (!HOME_CARD_SECRET_NAME) missing.push('HOME_CARD_SECRET_NAME');
  if (HOME_CARD_TARGETING === 'USERS' && !HOME_CARD_USER_ID) {
    missing.push('HOME_CARD_USER_ID');
  }
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

async function getSecretJson() {
  const secrets = new AWS.SecretsManager({ region: HOME_CARD_SECRET_REGION });
  const data = await secrets
    .getSecretValue({ SecretId: HOME_CARD_SECRET_NAME })
    .promise();
  if (!data.SecretString) {
    throw new Error('SecretString not found in Secrets Manager response');
  }
  return JSON.parse(data.SecretString);
}

function extractClientCredentials(secret) {
  const clientId =
    secret.clientId || secret.client_id || secret.CLIENT_ID || secret.clientID;
  const clientSecret =
    secret.clientSecret ||
    secret.client_secret ||
    secret.CLIENT_SECRET ||
    secret.clientSECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Secret must include clientId and clientSecret');
  }

  return { clientId, clientSecret };
}

async function getLwaToken({ clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'alexa::skill_event',
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LWA token error ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('LWA token response missing access_token');
  }

  return data.access_token;
}

function buildCampaignPayload(now) {
  const end = new Date(now.getTime() + HOME_CARD_EXPIRY_HOURS * 60 * 60 * 1000);

  const targeting =
    HOME_CARD_TARGETING === 'SKILL_SUBSCRIBERS'
      ? { type: 'SKILL_SUBSCRIBERS' }
      : { type: 'USERS', values: [{ id: HOME_CARD_USER_ID }] };

  return {
    suggestion: {
      variants: [
        {
          placement: { channel: 'HOME' },
          content: {
            values: [
              {
                locale: HOME_CARD_LOCALE,
                document: {
                  type: 'Link',
                  src: 'doc://alexa/apl/documents/home/cards/textWrapping',
                },
                datasources: {
                  displayText: {
                    headerText: HOME_CARD_HEADER,
                    primaryText: HOME_CARD_PRIMARY,
                    secondaryText: HOME_CARD_SECONDARY,
                    attributionText: HOME_CARD_ATTRIBUTION,
                    hintText: HOME_CARD_HINT,
                    action: {
                      type: 'SkillConnection',
                      uri: `connection://AMAZON.ColdLaunch/1?provider=${HOME_CARD_SKILL_ID}`,
                      input: {},
                    },
                  },
                  background: {
                    backgroundImageSource: HOME_CARD_IMAGE_URL,
                  },
                },
              },
            ],
          },
        },
      ],
    },
    targeting,
    scheduling: {
      activationWindow: {
        start: now.toISOString(),
        end: end.toISOString(),
      },
    },
  };
}

async function createCampaign(token, payload) {
  const response = await fetch(PROACTIVE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Proactive API error ${response.status}: ${text}`);
  }

  return response.json();
}

exports.handler = async () => {
  assertConfig();

  const secret = await getSecretJson();
  const credentials = extractClientCredentials(secret);
  const token = await getLwaToken(credentials);

  const payload = buildCampaignPayload(new Date());
  const result = await createCampaign(token, payload);

  return {
    statusCode: 200,
    body: JSON.stringify({ campaignId: result.id || result.campaignId || null }),
  };
};
