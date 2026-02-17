# Alexa Family Points Skill

Family Points Tracker is a custom Alexa skill that lets parents add or reduce points for family members and ask for a daily summary. Points are stored in a private Google Sheet.

## Features
- Add/reduce points for each child
- Daily summary with 3‑day trend chart on Alexa display devices (APL)
- Google Sheets as the data store (one tab per family)
- Name‑Free Interaction (NFI) support (best effort)
- Onboarding flow to collect child names

## Project Layout
- `alexa-points-skill/lambda/`: main skill Lambda
- `alexa-points-skill/skill-package/`: Alexa skill manifest + interaction model
- `alexa-points-skill/homecards/`: home card publisher (preview feature)
- `alexa-points-skill/legal/`: privacy policy and terms
- `alexa-points-skill/assets/icons/`: skill icons

## Configuration (Lambda)
Set these environment variables on the skill Lambda:
- `GOOGLE_SHEET_ID`
- `GOOGLE_SA_SECRET_NAME`
- `GOOGLE_SA_SECRET_REGION`
- `GOOGLE_FAMILIES_TAB` (default: `Families`)
- `GOOGLE_EVENTS_TAB_PREFIX` (default: `Family_`)

The Google service account JSON must be stored in AWS Secrets Manager. The file `alexa-points-skill/sa.json` is intentionally ignored by git.

## Onboarding
When a new user launches the skill, it prompts for kids’ names (e.g., “my kids are Anna and Ben”). The skill stores the names and creates a dedicated tab in Google Sheets.

## Notes
- Locale is English; copies exist for en‑US, en‑GB, en‑CA, en‑AU, en‑IN.
- Node.js runtime is `nodejs22.x`.
- NFI is best‑effort and may take time to activate.

## Legal
- Privacy Policy: `alexa-points-skill/legal/privacy-policy.html`
- Terms of Use: `alexa-points-skill/legal/terms-of-use.html`
