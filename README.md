# Alexa Family Points Skill

Family Points Tracker is a custom Alexa skill that lets parents add or reduce points for family members and ask for a daily summary. Points are stored in a private Google Sheet.

## Features
- Add/reduce points for Krish, Adith, Kamal, and Amirtha
- Daily summary with 3‑day trend chart on Alexa display devices (APL)
- Google Sheets as the data store
- Name‑Free Interaction (NFI) support (best effort)

## Project Layout
- `alexa-points-skill/lambda/`: main skill Lambda
- `alexa-points-skill/skill-package/`: Alexa skill manifest + interaction model
- `alexa-points-skill/homecards/`: home card publisher (preview feature)
- `alexa-points-skill/legal/`: privacy policy and terms
- `alexa-points-skill/assets/icons/`: skill icons

## Configuration (Lambda)
Set these environment variables on the skill Lambda:
- `GOOGLE_SHEET_ID`
- `GOOGLE_SHEET_TAB` (default: `Events`)
- `GOOGLE_SA_SECRET_NAME`
- `GOOGLE_SA_SECRET_REGION`

The Google service account JSON must be stored in AWS Secrets Manager. The file `alexa-points-skill/sa.json` is intentionally ignored by git.

## Notes
- Locale is `en-US` and uses the `us-east-1` Lambda region for Alexa endpoint compatibility.
- Node.js runtime is `nodejs22.x`.
- NFI is best‑effort and may take time to activate.

## Legal
- Privacy Policy: `alexa-points-skill/legal/privacy-policy.html`
- Terms of Use: `alexa-points-skill/legal/terms-of-use.html`
