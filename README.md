# OFFSCRPT V96.0.6 — MANUAL CREATOR PAYOUTS

Customer payments are collected by OFFSCRPT. Razorpay Route transfers are disabled for new creator payouts; authorized admins manually repay creators using the payout details stored in their seller profile.

# OFFSCRPT V96.0.6 — Trust, Moderation, Reviews & Marketplace Safety

Server-authoritative marketplace trust and moderation layer built on the V95 Commerce/Finance stack.

# V96.0.6 — TRUST, MODERATION, REVIEWS & MARKETPLACE SAFETY

## V88.0.6
My Purchases and secure digital-product downloads are available from `#purchases` / the authenticated account drawer.

## Current release: OFFSCRPT V96.0.6 — Trust, Moderation, Reviews & Marketplace Safety

# OFFSCRPT — V80.0.0 Intelligence Core

V80 connects the existing publishing, community, identity, reading, search, feed, AI, recommendation and analytics surfaces through shared compatibility layers. It preserves the existing V77–V79 systems, keeps OpenRouter behind the existing backend gateway, and adds server-enforced AI retrieval plus Master Control feature flags.

See `V80.0.0_INTELLIGENCE_CORE.md` for the implementation boundary and `BUILD_VALIDATION.txt` for the exact validation status.


OFFSCRPT is a general-purpose publishing, social and knowledge platform with a
long-form publication engine, community layer, personalized discovery and AI-assisted knowledge tools (posts, comments, follows, communities), creator analytics, a
personalized recommendation feed, moderation tooling, and a Firestore-authoritative admin
control center. It's a single-page React app backed entirely by Firebase (Auth + Firestore),
deployed as a static build to Vercel.

This README is written for two audiences: a human picking up the repo, and an AI coding
agent working on it. If you're an agent, **read the "Project conventions" section before
editing anything** — it documents a real failure mode this codebase has hit more than once.

---

## Stack

- **React 19 + TypeScript**, built with **Vite 6**
- **Firebase**: Auth (Google sign-in) and Firestore (all app data, no other backend)
- **Tailwind v4** (via `@tailwindcss/vite`) for styling
- **lucide-react** for icons, **motion** for animation
- Deployed as a static SPA to **Vercel** (see `vercel.json`)

There is no server component. All reads/writes go directly from the client to Firestore,
authorized entirely by `firestore.rules`. Treat that rules file as a second copy of your
application's authorization logic — a feature isn't done until the rules permit exactly the
read/write shape the client code actually sends.

---

## Project conventions

### `src/` is the only source tree. There is no second copy.

Vite's `root` is explicitly set to `src/` in `vite.config.ts`, and `src/index.html` loading
`src/main.tsx` is the real entry point. **Every application source file lives under `src/`.**

This project has repeatedly (three times as of V75.5) accumulated a duplicate top-level
`components/`, `lib/`, `data/` tree (with copies of `App.tsx`, `main.tsx`, `index.html`,
`package.json`, `VERSION.md`, etc. at the repo root or inside `src/`) that looked like a
mirror of the canonical tree but silently drifted out of sync — in one case an entire
runtime-error reporting feature existed in one tree and not the other; in another, a component
referenced a variable (`inputRef`) that only failed at runtime for signed-in users, because the
file that actually shipped was not the file that had been edited; most recently, three
headline features of a release (`ChangelogView.tsx`, `SiteAnnouncementPopup.tsx`,
`lib/siteFeatures.ts`) existed only in `src/` and were never even copied to the stale root tree.
**If you ever see a root-level `components/` or `lib/` directory that mirrors `src/`, or a
second `package.json`/`VERSION.md` inside `src/`, it is stale. Delete it — do not try to keep
it in sync by hand, and do not assume a changelog note claiming "synchronized" or "parity" is
accurate without actually diffing the two trees first.** Editing a file means editing it under
`src/`, full stop. This has recurred despite this exact warning already being in the README —
if you're an agent regenerating this project from a template or prior snapshot, check whether
your generation process is the one reintroducing the duplicate tree, since deleting it after
the fact only fixes it until the next regeneration.

### Verify before you call something done

```bash
npm run verify
```

This runs the full check pipeline: deployment config, `tsc --strict` typecheck, production
build, syntax parse, import resolution, export resolution, **undeclared-identifier detection**
(this is the check that would have caught the `inputRef` bug — it uses the TypeScript compiler
API to flag `TS2304`/`TS2552` diagnostics across every file in `src/`), Firebase client
sanity, Firestore rules structure, schema presence, and runtime-pattern checks. Individual
checks are also available separately (`npm run check:identifiers`, `npm run check:rules`,
etc. — see `scripts/`).

If you change `firestore.rules`, also run the actual rules simulator:

```bash
npm test   # or: npx vitest run firestore.rules.test.ts
```

This spins up the Firestore emulator's rules engine (`@firebase/rules-unit-testing`) and
asserts real allow/deny behavior against `firestore.rules`, rather than just checking the
file contains certain strings.

### When you add a new Firestore collection

Three things need to agree, or the write will silently fail (Firestore denies by default) or
succeed with a shape nothing else expects:

1. The client write (whatever calls `addDoc`/`setDoc`)
2. `firestore.rules` — add a `match` block with a validation function describing the exact
   field shape the client sends. Copy the pattern of an existing collection (e.g.
   `runtimeErrors`, `reports`) rather than starting from scratch.
3. If it's read from an admin/moderator surface, confirm the permission function used
   (`isAdmin()`, `isPlatformModerator()`, `hasModeratorPermission(...)`) matches what you
   actually want to gate on.

A mismatch here doesn't throw a build error — it fails at runtime, in production, for real
users, which is exactly how the `runtimeErrors` collection briefly had client code and
security rules disagreeing on field names (`userId`/`route` vs `uid`/`path`).

---

## Getting started

```bash
npm install
cp .env.example .env       # fill in Firebase Web SDK config
npm run dev                # http://localhost:3000
```

Required env vars (see `.env.example`): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
`VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`. Do not set a
`VITE_FIREBASE_DATABASE_ID` — this app uses Firestore's default database.

To deploy Firestore security rule changes, publish `firestore.rules` via the Firebase
Console (Firestore Database → Rules) or the Firebase CLI. The app will not enforce new
permissions until this is done — the rules file in the repo is not automatically synced to
your Firebase project.

```bash
npm run build       # production build to dist/
npm run preview      # serve the production build locally
```

---

## Architecture

```
src/
  App.tsx            Route/page switch, top-level state, error boundaries
  main.tsx            Entry point: root error boundary, PWA SW registration,
                       global runtime-error listeners
  types.ts            Shared TypeScript types (Article, Series, CommunityUser, ...)
  firestore.rules      Authorization for every collection — the real access-control layer
  components/          ~50 React components, one per view/feature surface
  lib/                 Firestore access + business logic, grouped by domain
  data/                Static seed data (default categories, etc.)
```

### `lib/` modules (by domain)

| Area | File |
|---|---|
| Firebase init, admin allowlist | `firebase.ts` |
| Articles, series, site config (CMS) | `cms.ts` |
| Community posts, follows, profiles | `community.ts` |
| Personal reading history/progress | `reading.ts`, `account.ts` |
| Recommendation scoring & cold-start | `personalization.ts`, `recommendations.ts` |
| Per-article analytics events & aggregation | `analytics.ts` |
| Social graph, moderation-adjacent social features | `social.ts` |
| Master Control admin operations (grants, moderator permissions, comment moderation, report resolution) | `masterControl.ts` |
| Admin audit log writer | `audit.ts` |
| User-submitted content reports | `reporting.ts` |
| Realtime presence (heartbeat + TTL) | `presence.ts` |
| Canonical URLs & sharing | `share.ts` |
| Runtime error capture (global listeners + Firestore/local-queue reporting) | `runtime.ts` |
| System/Firebase health checks | `health.ts` |
| Cross-tab/offline sync helpers | `sync.ts` |
| Toast notifications | `toast.ts` |

### Feature surfaces

- **Publishing**: articles, series, drafts, revisions, a rich CMS admin (`AdminStudioModal`,
  `AdminControlPanel`), public/community blog composers.
- **Discovery**: Explore (For You / Following / Latest / Trending), global search, topic
  pages, creator discovery.
- **Personalization**: weighted recommendation scoring (completed articles, bookmarks,
  followed creators/topics/series, trending, with per-recommendation "because you..."
  explanations and creator-diversity capping), cold-start topic picker for new accounts.
- **Community**: posts, nested comments with @mentions, reactions, follows, communities,
  direct messages.
- **Creator tools**: Creator Studio analytics dashboard (funnel, completion, scroll depth,
  return-reader rate, series drop-off, article comparison).
- **Trust & safety**: universal content reporting (`ReportButton` → `reports` collection),
  granular moderator permissions enforced in both the UI and Firestore rules, comment
  moderation, an admin audit log.
- **Realtime**: lightweight presence indicators (community/thread/article-level "N active"),
  TTL-based so presence documents don't accumulate unbounded.
- **Reliability**: page- and app-level React error boundaries, both wired to
  `lib/runtime.ts`'s error reporting (Firestore-backed for signed-in users, local-queued and
  flushed-on-login for signed-out users), plus a System Health view for admins.
- **Changelog & announcements**: a public `/changelog` page reading Firestore-backed release
  entries in realtime (`lib/siteFeatures.ts`'s `changelogEntries`, admin-editable, falling back
  to a hardcoded list only if the collection is empty), a user-facing problem-report form
  (`siteProblemReports`), and a cloud-configured popup/banner announcement system with audience
  targeting, scheduling, and per-user cloud-synced dismissal state (`users/{uid}/announcementState`).
  See "A note on the announcement system" below before editing this feature.

### Admin / moderator model

Two tiers, enforced in both the client UI and `firestore.rules` (never trust the client-side
check alone — rules are the actual authority):

- **Master admin**: allowlisted by verified email in `firestore.rules`'
  `isAdmin()`, or granted dynamically via `masterAdmins`/`masterAdminEmails` documents
  (`lib/masterControl.ts`). Full access to every admin surface.
- **Platform moderator**: an entry in `siteModerators/{uid}` with a granular permission map
  (e.g. `manageReports`, `moderatePosts`, `moderateComments`). `hasModeratorPermission(...)`
  in the rules file checks this per-action, not just "is a moderator."

Every sensitive admin/moderator mutation should call the shared `audit()` helper (in
`masterControl.ts`) or `writeAdminAudit()` (in `audit.ts`) so it lands in `adminAuditLog`,
visible from the Admin panel's Audit tab.

### A note on the announcement system

`SiteAnnouncementPopup.tsx` renders as a full-screen fixed overlay (`inset-0`) when
`displayMode` is `popup`/`modal`. If an announcement is published with `dismissible: false`
and no working `actionLabel`/`actionTarget` or `linkLabel`/`linkTarget` pair, there is no way
for a visitor to close it — and since `targetPage` defaults to `all`, this can block the
entire site for every visitor with no recovery path short of an admin editing Firestore
directly or a redeploy. This happened (V75.3–V75.4) before a fix shipped in V75.5.

Two layers of protection exist now, and **both should stay in place** if this component is
ever rewritten:

1. `AdminControlPanel.tsx`'s publish handler refuses to save an enabled announcement with
   neither a dismiss option nor a working action button.
2. `SiteAnnouncementPopup.tsx` itself computes `effectivelyDismissible` and forces dismiss
   controls (plus Escape-to-close) to render whenever no other close route exists, as a
   safety net against stale config or a future editing path that skips check #1.

If you change this component, keep both checks, or add an equivalent guarantee that an
enabled announcement can never render as fully inescapable.

---

## Version history

Each release used to get its own `V*.md`/`*_VALIDATION.md` file at the repo root; those have
been consolidated away since they were single-use scratch notes that didn't stay accurate
after the next release. `VERSION.md` holds the current release's changelog. For anything
older, check git history / prior zip exports rather than expecting a markdown file per version
going forward.


## V75.4 Announcement + Changelog system

- Master Admin controls cloud-backed announcements with type, priority, display mode, frequency, audience, target page, schedule, and actions.
- Signed-in dismissal state is stored per account under `users/{uid}/announcementState/{announcementId}`; guests use browser-local state.
- Published changelog entries are stored in `changelogEntries` and rendered publicly in realtime.
- Master Admin can create, edit, delete and publish changelog entries from Master Control.


## V75.6 — Cloudflare R2 media uploads

V75.6.1 fixes R2 upload authentication by validating Firebase ID tokens through Firebase Auth. The upload API also accepts the earlier `CLOUDFLARE_ACCOUNT_ID`/`R2_PUBLIC_URL` aliases.

OFFSCRPT now uses Cloudflare R2 for image/video/PDF binary uploads while Firestore remains the application database. Uploads are authorized through `/api/media/upload-url` using the signed-in Firebase user token; browsers receive a short-lived R2 presigned PUT URL and upload directly to R2. Firestore stores only public media URLs/object metadata.

### Vercel environment variables
Set these server-side variables in Vercel: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`, `R2_PUBLIC_BASE_URL`, `OFFSCRPT_ADMIN_EMAILS`. Do not expose the R2 access key or secret with `VITE_`.

### R2 CORS
Allow your production site origin and `PUT`, `GET`, `HEAD` methods with the `Content-Type` request header. Configure a public custom domain such as `media.offscrpt.app` for `R2_PUBLIC_BASE_URL` when ready.

### Upload locations
`users/{uid}/profile` for profile media, `users/{uid}/posts` for user post media, `users/{uid}/videos` for user videos, `users/{uid}/attachments` for PDFs, and `site/articles` / `site/carousel` for admin site media.

### Limits
Images 10 MB, videos 250 MB, PDFs 25 MB by default. These are server-side limits and can be changed with environment variables.


## V75.8 — Media-rich community, discovery & links

The shared `MediaUploadButton` now supports single or multiple files and is wired through the main media-bearing surfaces: public blogs, community posting, profile/cover editors, creator pages, series covers, carousel slides, Master User Control, global branding and the Master Admin Media Center.

The Media Center supports site assets, article media, carousel media, videos and PDF attachments. Uploads still use authenticated Firebase ID tokens to create short-lived Cloudflare R2 presigned PUT URLs; the browser uploads directly to R2. `site` is a Master-only destination and is stored under `site/assets`.

## V75.8 — Media-rich community, discovery & links
Community creators can upload a logo/icon and banner when creating a community, and existing community managers can continue updating both. Home personalization cards now render article covers. The Links/Bento admin builder accepts an uploaded logo/image per link; public link cards render that image when available and otherwise retain the configured solid color.

## V75.8 — Media-rich community, discovery & links
Community creators can upload a logo/icon and banner when creating a community, and existing community managers can continue updating both. Home personalization cards now render article covers. The Links/Bento admin builder accepts an uploaded logo/image per link; public link cards render that image when available and otherwise retain the configured solid color.

## V75.9 — Global Image Crop + Preview

All local image uploads now open a reusable crop/preview editor before any R2 upload occurs. Users can drag, zoom, rotate, select common aspect ratios, preview the processed output, and explicitly confirm with USE IMAGE. The processed image is then uploaded through the existing authenticated R2 presigned-upload flow. Video/PDF uploads remain unchanged, and external image URLs continue to work as URL fields without triggering the cropper.
EOF
cat > /mnt/data/v759work/V75.9_IMAGE_CROP_PREVIEW.md <<'EOF'
# V75.9 — Global Image Crop + Preview

## Workflow

SELECT IMAGE → IMAGE EDITOR → PREVIEW CROP → USE IMAGE → PROCESS → R2 UPLOAD → SAVE URL

## Coverage

The reusable MediaUploadButton now intercepts every local image selection site-wide. Existing video and PDF upload flows bypass the cropper. Existing image URL inputs remain URL inputs.

## Context defaults

- Avatar/profile picture/icon/logo: 1:1 circle, 800×800
- Cover/banner/carousel/hero: 16:9, 1600×900
- Post image: 4:3, 1400×1050
- General article/content images: Free, max-oriented 1600×1200

## Output

- PNG sources stay PNG for transparency preservation.
- Other image sources prefer WebP at high quality.
- Oversized outputs are bounded to a practical maximum.
- Cropped result is uploaded instead of the original source file.

## Failure behavior

If the R2 upload fails, the processed crop is retained for retry and the existing field value is not changed by the uploader itself until `onUploaded` receives a successful URL.


## V75.10 — Firestore Quota-Safe Profile Updates
- Reduced unnecessary Firestore reads during self profile edits.
- Avoided re-reading the profile after successful updates for identity propagation.
- Kept Cloudflare R2 uploads independent from profile persistence.
- Added a quota-specific message when Firestore returns `resource-exhausted` / quota errors, so successful R2 uploads are not mislabeled as media-upload failures.


## V75.12 — Firestore Quota & Usage Optimization

V75.12 hardens Firestore usage without changing Firestore into a different data store. The release adds short-lived in-memory caches, in-flight request deduplication, quota cooldowns, bounded retry behavior, fewer always-on recommendation listeners, cached platform counts, throttled admin identity synchronization, and profile cache invalidation after writes. Quota failures are not retried automatically.


## V75.13 — Site-wide media completion
- Social Admin community icon/banner uploads with crop/preview and cloud save.
- Creator Page custom link logo/image uploads with R2 + public rendering.
- Carousel new-slide image upload uses the crop/preview flow; duplicate upload control removed.

## V76 — Social Feed + Discovery Engine
The home experience now includes a unified discovery feed, algorithmic/chronological modes, cloud-synced recommendation controls, dynamic personalized sections, and bounded on-demand discovery for discussions and communities. Existing recommendation signals, Firestore quota protection, Firebase Auth, R2 media, and prior features are preserved.


## V76.0.1 — Home Runtime Fix
- Fixed home-page temporal-dead-zone crash (`Cannot access 'Ce' before initialization`).
- Reordered derived feed values so memoized sections never reference `displayedArticles` before initialization.
- No existing features removed.


## V77 — Questions + Answers Engine

V77 adds first-class Questions with deep-link pages, follow/notifications, answer voting, accepted answers, rich answer media, search, related questions, anonymous presentation and Master moderation while retaining the full V76 feed/discovery and existing R2 media stack.


## V77 — Questions + Answers
V77 upgrades the existing discussion/question foundation into a first-class Q&A layer without removing prior V76 functionality.

## V77.0.1 — Vercel Build Fix

Removed a duplicate `getQuestionForModeration` export from the Questions + Answers data layer. This release preserves V77 functionality and fixes the production bundler failure caused by duplicate symbol declarations.


## V77.0.3 — Theme + Runtime Hardening
- New visitors default to light mode instead of inheriting system dark mode.
- Explicit local theme preference remains respected.
- Signed-in theme remains cloud-synced.
- Dynamic manifest routes use absolute origin URLs.


## V77.0.4 — Question Answer Runtime/Permissions Fix
- Fixed public answer creation by safely allowing atomic answer-count/reply-count updates using Firestore getAfter validation.
- Improved question answer media layout and replaced raw uploaded URLs in the composer with visual previews and remove controls.
- Preserved new-visitor light theme behavior.


## V77.0.5

Question-page runtime hardening: fixed React hook ordering for the QuestionView and retained guest-first-visit light theme behavior.


## V81 Universal Knowledge Engine

V81 adds the user-facing Knowledge, Research and My Vault surfaces on top of the V80 Intelligence Core. Use `#knowledge`, `#research` and `#vault` or the Command Palette. See `V81.0.0_UNIVERSAL_KNOWLEDGE_ENGINE.md` and `BUILD_VALIDATION.txt` for scope and verification.

