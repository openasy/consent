# consent

[![CI](https://github.com/openasy/consent/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/consent/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Consent product: one record per person of what they agreed to, for which
purpose and channel (email, SMS, call or the website), when, from which source, and to which version of the text. It
keeps İYS, Türkiye's İleti Yönetim Sistemi, in step both ways, gives sites a cookie banner and a preference page from
one script tag, and answers the other products' question: may we reach this person on this channel for this purpose?

```
consent.yaml ──▶ consent ──▶ /c/shop.js ──▶ <script> on the site: banner and preference panel
                  ▲   ▲  ▲                         │
                  │   │  └── /api/v1/choices ◀─────┘  answers from the banner and the preference page
                  │   └───── /api/v1/check, /api/v1/consents ◀── Messages, Analytics, Forms, Audience, your apps
                  └───────── İYS: answers sent, changes read back every few minutes
```

## Purposes, sites and İYS in a file

Everything Consent asks is set in `/config/consent.yaml` (`CONSENT_CONFIG`):

```yaml
purposes:
  - id: analytics
    name: { en: Measurement, tr: Ölçüm, de: Messung }
    channels: [web]
    versions:
      - version: 1
        text:
          en: Which pages are read, kept by us and nowhere else.
          tr: Hangi sayfaların okunduğu; yalnızca bizde saklanır.
  - id: marketing
    name: Offers and news
    channels: [email, sms, call]
    iys: true # the brand's commercial message consent, kept in step with İYS
    versions:
      - { version: 1, from: 2026-01-01, text: "Offers and news from Example by email, SMS and phone." }
      - { version: 2, renew: true, text: "Offers, news and surveys from Example by email, SMS and phone." }

sites:
  - name: shop
    domains: [https://www.example.com]
    analytics: analytics # starts OpenAsy Analytics on a site with consent: required

iys:
  account: 123456 # your İYS number
  brand: 654321 # the brand's code in İYS
  username: CONSENT_IYS_USERNAME # the environment variables that hold the API user, never the values
  password: CONSENT_IYS_PASSWORD
```

The file is the only way in: no screen and no API route adds, changes or removes a purpose or a site, so the list can
live in git and be reviewed like code. It is read at start and again within a minute of a change, and applied whole or
not at all. A file with a mistake leaves the last good version in place, and the log and the UI say which entry and
field to fix. Mount the folder rather than the file, so a save that replaces the file still reaches the container.

**A version's text never changes once applied.** Consent keeps every version's text as it was first applied. A file
that changes the text of a version people may have seen is refused: put it back and add the next version. Earlier
consents stay tied to the version they were given for. With `renew: true` on a new version, answers to earlier
versions no longer count, and the banner asks again.

| Purpose field | | |
| --- | --- | --- |
| `id` | required | Lowercase letters, digits and `-`; the API and the products name the purpose by it |
| `name` | required | A text, or a map of `en`, `tr` and `de` texts |
| `channels` | required | `email`, `sms`, `call`, or `web` alone (cookies and storage in the browser) |
| `versions` | required | Oldest first: `version` (a number larger than the one before), `text`, optional `from` (the date it came into force) and `renew` |
| `iys` | `false` | `true`: answers on its email, SMS and call channels are the brand's commercial message consent, sent to and read from İYS. One purpose per channel |
| `required` | `false` | For `web` purposes the site cannot work without: shown on the banner, always on, never asked |

| Site field | | |
| --- | --- | --- |
| `name` | required | The script is `/c/<name>.js`, the preference page `/preferences/<name>` |
| `domains` | required | The origins whose pages may send answers; `http://` only for localhost |
| `banner` | every `web` purpose | The purposes asked on the banner |
| `preferences` | every message purpose | The purposes a preference link shows, by channel |
| `analytics` | | The banner purpose whose answer calls OpenAsy Analytics' `openasy.consent()` |
| `privacy` | | The site's privacy notice, linked from the banner |
| `language` | the page's `<html lang>` | `en`, `tr` or `de` |

| İYS field | | |
| --- | --- | --- |
| `account`, `brand` | required | İYS's numbers for the account (İYS kodu) and the brand (marka kodu) |
| `username`, `password` | required | The names of the environment variables that hold the API user and its password |
| `url` | `https://api.iys.org.tr` | `https://api.sandbox.iys.org.tr` to try it first |
| `recipientType` | `BIREYSEL` | `TACIR` for traders |
| `pull` | `5m` | How often İYS's changes are read |
| `source` | `HS_WEB` | The İYS source sent for answers that do not name one |

## On the site

```html
<script src="https://consent.example.com/c/shop.js" defer></script>
<a href="#" data-openasy-preferences>Cookie settings</a>
```

The banner asks until the visitor has answered the current text of every purpose on it. Rejecting all is one click,
as accepting all is, and nothing on a purpose is allowed before an answer. The answers are kept in the browser's
`localStorage` with a random browser id, and sent to Consent. Any element with `data-openasy-preferences` opens the
preference panel again.

```js
OpenAsyConsent.get("analytics"); // true, false, or null before an answer
OpenAsyConsent.on((answers) => {}); // whenever an answer changes; returns a function that stops it
OpenAsyConsent.open(); // the preference panel
window.addEventListener("openasy:consent", (e) => e.detail); // the same answers, as an event
```

On a site with `analytics:` in the file, a yes on that purpose calls `openasy.consent(true)` of OpenAsy Analytics
(queued when Analytics loads later) and a no calls `openasy.consent(false)`, which stops Analytics and deletes what it
kept about the visitor.

**The preference page.** A preference link, made with `POST /api/v1/links`, names a person; put it in the footer of an
email or an SMS. It opens `/preferences/<site>?t=...`, where the person sees the site's banner purposes and their own
message purposes by channel, and changes them. On the site's own pages, `?openasy_consent=<token>` in the address, or
`data-token` on the script tag, does the same. Links are signed and run out after 180 days unless `days` says
otherwise; message purposes are never changed without one.

## For the products: may we?

```bash
curl -s https://consent.example.com/api/v1/check -H "authorization: Bearer $TOKEN" -G \
  -d purpose=marketing -d channel=sms -d phone=+905551112233
# {"person":"…","purpose":"marketing","channel":"sms","status":"granted","allowed":true,"version":1,"current":1,…}
```

A person may be reached on a channel for a purpose only while their latest answer for it is yes, to a version the
file still counts. The latest answer is the one given last, by its time, not the one recorded last: an old consent
imported today does not undo a refusal from last week. `status` is `granted`, `withdrawn`, `renew` (yes, to a text
that asks again) or `none`. Name the person by `email`, `phone`, `id` (your own) or `browser`; identifiers that name
two different people are answered no. `POST /api/v1/check` takes up to 1000 people at once, for a campaign's list.

Record answers from your forms and applications:

```bash
curl -s -X POST https://consent.example.com/api/v1/consents -H "authorization: Bearer $TOKEN" -d '{
  "person": { "email": "ayse@example.com", "phone": "0555 111 22 33" },
  "source": "form", "via": "forms/newsletter",
  "answers": [{ "purpose": "marketing", "channel": "email", "granted": true, "proof": "newsletter form, double opt-in" }]
}'
```

Each answer may carry the `version` the person saw (by default the one in force when they answered), `at`, an İYS
`iysSource` such as `HS_CAGRI_MERKEZI`, and a `proof`. Use `"source": "import"` with `at` to bring in earlier
records. Phone numbers are kept as İYS takes them, `+905551112233`; emails lowercased. The API reference is at
`/api/docs/`, and every response is tested against `openapi.json`.

## The history

Every answer is a row that nobody can change: the database itself refuses an update or a delete of the history and of
a version's text. A change of mind is a new answer. Each row keeps the purpose, channel, version, yes or no, when it was
given and when it was recorded, its source (`banner`, `preferences`, `api`, `form`, `import` or `iys`), where it came
from (`via`: the site, the form), who recorded it (a member's email or `token:<name>`), the İYS source and the proof.

**Erasure on request.** An admin can erase a person (`DELETE /api/v1/people/{id}?reason=`), for a request under KVKK
Art. 7 and 11 or GDPR Art. 17. Their identifiers and history are removed, the outbox keeps no address of theirs once
sent, and the erasure is logged in `/api/v1/deletions` with who, when, why and how many rows, without the person's
identifiers; nobody can change or remove that log. İYS has no erasure: Consent sends it a refusal for every channel the
person had said yes to. Whether a record must instead be kept as proof is a legal question for you.

## İYS, both ways

- **To İYS.** An answer on the purpose with `iys: true`, on email, SMS or call, goes into an outbox and is sent with
  `POST /sps/{account}/brands/{brand}/consents` within half a minute: `ONAY` or `RET`, `EPOSTA`, `MESAJ` or `ARAMA`, the
  recipient, its source, and the time it was given in Türkiye's time. Each recipient's answers go in the order they
  were given. When İYS is away, the answer waits and is tried again after 1, 2, 4 minutes and so on, up to 6 hours;
  when İYS refuses it (a 4xx), it is kept as failed with İYS's message, shown on the İYS page, and sent again with
  Send again (`POST /api/v1/iys/retry`).
- **From İYS.** Every `pull` minutes, Consent reads `GET /sps/{account}/brands/{brand}/consents/changes` from where it
  stopped. An answer İYS got from elsewhere, such as STOP to an SMS or a change on İYS's site, is added to the history
  with source `iys`, for the person with that email or phone (added if new) and the version in force at the time.
  Answers Consent sent itself are recognised by their transaction id and not recorded twice.
- **When they disagree,** both answers are kept and the later one counts. The People and İYS pages list everyone
  İYS and the record disagree about, with both answers.
- **Signing in** is `POST /oauth2/token` with the API user and its password from the environment; the token is kept in
  memory and renewed a minute before it runs out, or when İYS refuses it.
- An admin can ask İYS directly what it holds for a recipient (`GET /api/v1/iys/lookup`), and sync now.

**Tested only against a fake İYS.** The İYS client follows İYS's published API and its open-source clients, and is
tested against the fake İYS in `server/iys-fake.ts`; it has never reached the real İYS or its sandbox. Before you rely
on it, point `iys.url` at `https://api.sandbox.iys.org.tr` with a sandbox account and check that: the token request is
JSON with `grant_type: password`; `consents/changes` takes `after` and `limit` and answers `{ after, list }`; a change
lists `recipient`, `type`, `status`, `source`, `consentDate` and `transactionId`; and İYS lists the brand's own answers
back with the transaction id it gave them. Answers recorded before `iys:` was set are not sent afterwards.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/consent.yaml   # your purposes, sites and İYS
docker compose up -d
docker compose logs consent | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI, the
API, the banner and the preference page are on http://localhost:8080. Sites on `https://` can only load the script
from `https://`, so put Consent behind TLS. `openasy-kek` encrypts sign-in secrets in the database (ADR 0021): keep it
apart from the volume and with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CONSENT_PUBLIC_URL` | `http://localhost:8080` | The address people open, the banner sends to, and preference links point at, with `https://` behind your TLS proxy |
| `CONSENT_CONFIG` | `/config/consent.yaml` | The file |
| `CONSENT_IYS_USERNAME`, `CONSENT_IYS_PASSWORD` | | The İYS API user, under the names the file's `iys.username` and `iys.password` give |
| `CONSENT_RATE_LIMIT` | `1200` | Requests a minute a site's banner and preference page may send. Over it: 429 with `Retry-After` |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `CONSENT_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `CONSENT_DB` | `/data/consent.db` | SQLite file (WAL), on the `/data` volume |
| `CONSENT_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `CONSENT_HEADLESS` | `false` | `true` serves only the API, the banner and the preference page |
| `CONSENT_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. The banner's
requests are not written to the request log, and request logs never hold the query string, which may name people.
The rate limit and the Checks page's latest checks are kept in memory only.

## Roles

Viewers see every person, purpose and check, and may ask `/api/v1/check`; editors also record answers and make
preference links; admins also erase people, sync İYS and send refused answers again, and manage members and API tokens
(ADR 0003). Give each product its own API token, so the Checks page and the history say which one asked and recorded.

## Limits

- It records and enforces consent; whether a purpose needs consent is a legal question for you.
- İYS covers commercial electronic messages in Türkiye; other countries' registries are not included.
- İYS keeps one answer per brand and channel, so only one purpose per channel can hold it (`iys: true`).

## Develop

```bash
npm install
npm test        # the file, the history and its rules, İYS both ways against a fake İYS, the banner in jsdom, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
