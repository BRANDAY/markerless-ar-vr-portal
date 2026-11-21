# Connecting ReactVision Advanced VPS as a second way to hold the door

State as of 2026-11-21. The self-hosted server stays the main way to find the place and the door. This document covers the second way the owner chose on 2026-11-21: **ReactVision Advanced VPS**, a ready-made cloud service that is built into the AR library the app already uses. We do not build a cloud of our own.

This is a plan. Nobody has tried the service by hand yet: it needs a paid account, which only the owner can open. What is known comes from the vendor's documentation and from the source of the installed library (`app/node_modules/@reactvision/react-viro`, version 3.2.2; paths below are relative to that package). The provider itself is written by the app chat, in place of the stub `ReactVisionVpsProvider` in `app/src/localization/stubs.ts`.

## 1. Why this service

Advanced VPS does what the assignment asks: a place is scanned once, and afterwards any phone recognises it from the camera picture and shows content at the same spot, with no markers and no GPS. It ships inside ViroReact 3.2.2 (`components/AR/ViroVPS.tsx`, `ViroVPSAnchor.tsx`), so the app needs no native module of its own, and the recording our app already makes for the self-hosted server is the same recording the service takes. It maps the whole room, not one spot. The price is known and small for a trial: the Basic plan at $25 a month. The other candidates lose on one of these points: Google ARCore Cloud Anchors are free but remember one anchor and live 24 hours with an API key; MultiSet and Immersal need a native module of ours and cost from $99 a month for real use; Niantic has no React Native kit.

What speaks against it, and is accepted: the feature was released on 2026-11-08, there is no independent review of it, and all accuracy figures are the vendor's own.

## 2. How it works, in our terms

**Registering the place (staff, once).**

1. The staff member records a walk through the room. The app already does this for our server: `startRecording` / `stopRecording` on the AR view give `video.mp4` and `session.jsonl`.
2. The recording is sent to ReactVision with `uploadScanRecording(...)`. Sending needs a short-lived **user token**; a client key is refused.
3. The cloud builds a map. `getScan(...)` reports `queued`, `processing`, then `succeeded` or `failed`. A map is accepted only if it has at least 500 points and passes the service's self-check. How long this takes is not documented.
4. The place gets a `location_id`.

**The door.** The service has no "save this door" call. Content is placed by coordinates in the frame of the map (metres, Y up), and those coordinates are the same for every phone and every session. Where we keep them is our decision; see section 5.

**The visitor.** The app starts `<ViroVPS>` and calls `startTracking(locationId)`. The phone downloads the map (about 1 MB), matches the camera against it and reports the states `searching`, `mapLoaded`, `tracking`, `lost`, `error`. Once it is `tracking`, the app knows where the map is in the current AR session and can put the door at its saved coordinates. `startTracking("auto")` must not be used: it starts from GPS.

Two ways of matching:

| | On the phone (`localization="device"`) | On the vendor's server (`localization="server"`) |
|---|---|---|
| Network | Only to download the map | All the time |
| Price | Nothing on top of the plan | $0.60 per minute |
| Holding up over days and in other light | Weaker | Better, by the vendor's words |

The default for us is `device`.

## 3. What the owner has to do

Nothing below was done for you: no account was opened, no terms were accepted, nothing was paid and no key was created.

**Cost.** The Basic plan is $25 a month ($250 a year); take the monthly one for the trial. It includes $5 of compute time a month. Building a map from a scan costs $0.60 a minute and is charged only when the map is accepted, so the included $5 covers about 8 minutes of processing. Finding a place on the phone (`device` mode), downloading maps and reading are not billed. Finding on the vendor's server costs $0.60 a minute. Storage on Basic is 1 GB. No student discount is listed.

1. **Account.** Sign up at https://studio.reactvision.xyz and create a project, for example "AR Portal". The site will ask to accept its terms.
2. **Plan.** Switch the team to **Basic** and add a payment card. The card is required even with the included credit: without a payment method that can be charged for compute time the service answers `403 COMPUTE_BILLING_NOT_SET_UP`. The documentation does not say on which page the plan is changed; look for billing or plan in the team settings.
3. **Spend limit, before anything is scanned.** On the team's **Usage** page lower the monthly compute limit from the default $100 to a small sum, for example $10. The smallest allowed value is not documented. When the limit is reached, paid work is refused with `403 COMPUTE_SPEND_LIMIT_REACHED` until the next period; nothing more is charged.
4. **Project ID.** Open the project, press **Edit** (top right); the ID is under the project name with a **Copy** button.
5. **Client key.** In the team sidebar: **Integrations → API Keys → Create Key**, kind *client*, for this project. It starts with `rv_client_`.
6. **Secret key.** Same page, kind *secret*. Give it the `vps` scope only; the scope is chosen at creation and cannot be changed later. It starts with `rv_secret_`. **The site shows it once**: copy it straight into the server file of section 4.
7. **Files.** Put the three values into the two files described in section 4. Do not paste them into a chat, a document or any file of the repository.
8. Tell the chats that the files are in place, without the values.

You do not create the fourth value, the user token (`rv_ut_`): our server makes it when a staff phone needs one.

If a key leaks: delete it on the API Keys page and create a new one. Deleting a secret key also cancels every token made with it.

Not documented, so decide with that in mind: what happens to registered places when the plan is cancelled or lowered.

## 4. Where the keys are kept, and what the build expects

The repository is public. No key, token or project number is written into any file inside it, and none is pasted into a chat. Documents and code name the variables only.

### Who holds what

| Value | Looks like | Who holds it | What it is for |
|---|---|---|---|
| Project ID | a UUID | the app build and the server | Says which ReactVision project the calls belong to. Not a secret by itself, but kept with the keys. |
| Client key | `rv_client_…` | the app build, so every phone | Finding a place and downloading its map. It cannot create places or upload scans. It ends up inside the APK. |
| Secret key | `rv_secret_…` | **our server only** | Full access: creating and deleting places, minting user tokens. Never in the app, never on a phone. |
| User token | `rv_ut_…` | nobody keeps it | Made by our server from the secret key for one staff phone, lives about an hour, lets that phone upload a scan. It is fetched when needed and not stored. |

### Files, outside the repository

Proposed place: a folder next to the other local project data, `E:\VR-FESB\secrets\`. Two files, so the app build never reads the secret key:

`E:\VR-FESB\secrets\reactvision-app.json`, read when the app is built:

```json
{
  "rvProjectId": "<project id>",
  "rvApiKey": "<client key>"
}
```

`E:\VR-FESB\secrets\reactvision-server.env`, read when the server starts:

```
RV_PROJECT_ID=<project id>
RV_SECRET_KEY=<secret key>
```

If the folder should be somewhere else, one environment variable can point to it (suggested name `VRFESB_SECRETS_DIR`). The app chat and the server chat settle the exact names when they write the reading code; this document will be brought in line with theirs.

### What the app build expects

The Expo plugin of the library takes the values as options (`plugins/withViroAndroid.ts:378-383`):

```json
["@reactvision/react-viro", {
  "android": { "xRMode": ["AR"] },
  "provider": "reactvision",
  "rvApiKey": "<from reactvision-app.json>",
  "rvProjectId": "<from reactvision-app.json>",
  "telemetry": false
}]
```

The vendor's setup page shows only `rvApiKey` and `rvProjectId`; `"provider": "reactvision"` is what the plugin assumes anyway once a key is present (`plugins/withViroAndroid.ts:371-373`), and it is written out here because our file says `"none"` today.

Today `app/app.json` has `"provider": "none"` and no keys. Because `app.json` is committed, the values cannot be typed into it. The build needs a small `app.config.js` that reads `reactvision-app.json` and adds the three options; when the file is missing it leaves `"provider": "none"`, so a machine without keys builds the app exactly as today.

Where the values go after that:

- `expo prebuild` writes them into `app/android/app/src/main/AndroidManifest.xml` as `com.reactvision.RVApiKey` and `com.reactvision.RVProjectId`. The whole `app/android` folder is ignored by git (`app/.gitignore`), so they do not reach the repository. They are inside every APK built this way; that is what a client key is for, but such an APK should not be attached to a public release.
- The library reads them from the manifest by itself. `<ViroVPS>` uses them when no `credentials` prop is given (`components/AR/ViroVPS.tsx:150-157`).
- The AR view needs the service switched on as well. `ViroARSceneNavigator` takes `provider="reactvision"`, and that is also its default when the prop is missing (`components/AR/ViroARSceneNavigator.tsx:2342-2345`). `App.tsx` does not pass the prop today.

One side effect to know: with `"provider": "reactvision"` the plugin adds the two location permissions to the manifest (`plugins/withViroAndroid.ts:391-407`). Finding a place by its `location_id` needs no GPS, and the app must not ask the visitor for location at run time.

### What the server expects

The server reads `RV_PROJECT_ID` and `RV_SECRET_KEY` from its environment and gives a staff phone a user token on request. The mint, as the vendor documents it:

- `POST https://platform.reactvision.xyz/functions/v1/app-user-tokens`
- headers: `x-api-key: <secret key>`, `content-type: application/json`
- body: `project_id`, `app_user_id` (our own name for the staff phone: 1 to 255 printable ASCII characters, no spaces), optional `ttl_seconds` (60 to 3600, default 3600), `scopes: ["vps"]`
- answer: `token` (starts with `rv_ut_`), `expires_in`, `expires_at`, `scopes`

On the phone the token is handed to the library with `createUserTokenCredentials({ projectId, fetchToken })`, where `fetchToken` asks our server (`components/AR/ViroUserTokenCredentials.ts`). One app user gets at most 60 tokens an hour, so the helper keeps a token and renews it shortly before it runs out; the server should not mint one per request.

## 5. Where the door's place is stored

**Proposal: on our own server, with the room.** For each room the server keeps, next to what it has today:

- the `location_id` of the place at ReactVision;
- the door pose in the frame of the ReactVision map (position in metres, heading);
- the width and height of the door.

The phone receives these together with the room, as it already receives the door and the room plan, and keeps the last copy so the door can be shown when only the internet is reachable.

Why there: the staff member sets the door once and it is saved in one place for both ways; nothing about the door has to be entered in the vendor's web editor; and removing or moving the door stays one action. The alternative is a scene in ReactVision's editor bound to the place. That keeps the door in the vendor's cloud, the steps are not documented, and the app would have to load vendor scenes.

Not decided: a venue with no server of ours at all would need another carrier for these three values (the vendor's editor, or a small file delivered with the app). The owner's decision of 2026-11-21 has the door and the room coming from the server, so this case is outside the current work.

**How the staff's door becomes map coordinates.** The staff member places the door in the room; that pose is in the AR frame of the current session. While the phone is tracking the place, `onLocalized` reports `renderPose`: the camera's pose in the map frame, a 4x4 matrix of 16 numbers in column-major order (`components/AR/ViroVPS.tsx:378-386`). With the camera's pose in the AR frame at the same moment:

- map-from-session = `renderPose` × inverse(camera pose in the session);
- door in the map = map-from-session × door in the session. This is what is saved.

A visitor's phone does the reverse: door in the session = inverse(map-from-session) × door in the map, and gives the result to the app through the existing `emitPose`. The reviewing chat proposed this instead of putting the portal inside `<ViroVPSAnchor>`, because that component moves its content every frame and our portal must not move while someone walks through it. With `emitPose`, the rules that already exist apply ("do not move the door while the user is inside").

So the door for this way can be saved only after the cloud has built the map and the staff phone has recognised the place. If the door was already placed for our own server in the same session, its pose is still valid and is converted at that moment.

## 6. Plan of the connection

In the order that shows problems earliest. Steps 1 and 2 are the owner's; the rest is written by the app chat and the server chat.

1. The owner opens the account, pays for Basic, lowers the spend limit and creates the keys (section 3).
2. The owner puts the values into the two files (section 4).
3. **Build with the service on.** `app.config.js`, a new build. First check on the phone: everything that works today still works with `"provider": "reactvision"`: AR, the recording for our server, the depth mesh.
4. **Server: token for the staff phone.** One endpoint that returns a user token; the secret key stays on the server. Also the three stored values of section 5.
5. **Staff: send the recording to ReactVision.** The same folder that goes to our server is given to `uploadScanRecording`; the app shows the state from `getScan` until the map is accepted or refused, and saves the `location_id` on our server.
6. **Visitor: find the place.** `<ViroVPS>` with `localization="device"`, `startTracking(locationId)`; the provider maps the states to its own statuses.
7. **The door.** Conversion of section 5 in both directions; saving on the server; `emitPose` for the visitor.
8. **Comparison on one room.** The same recording, the same door, both ways; times and offsets through the measurement log the app already has.

Step 5 has a possible shortcut worth checking before it is written: the recording already reaches our server, and the secret key lives there. If the service's REST interface accepts a scan uploaded from the server, the phone would need no token at all. The documentation read so far describes the upload only through the library call.

## 7. Risks and limits

| Risk | What follows |
|---|---|
| The feature is two weeks old and has no independent review. | Take the vendor's accuracy figures as claims. Our own numbers come from step 8. |
| Processing time of a scan is unknown. | The staff flow needs a "the cloud is building the map" state that can last minutes, and must survive closing the app. |
| A refused map (fewer than 500 points, failed self-check). | The app must say so and ask for a new walk. Refused scans are not billed. |
| Matching on the phone may be weak after days or in other light. | The vendor's own test: after nine days on a car park the server recognised 77 % of frames, the phone 16 %. Server mode costs $0.60 a minute and needs the network all the time. |
| Money. | Server mode for an hour is about $36. The spend limit is the protection; set it low before the first scan. |
| The portal inside `<ViroVPSAnchor>` may jump during a walk-through. | Use `renderPose` and `emitPose` (section 5). To be checked on the phone. |
| `renderPose` and our camera pose are read at slightly different moments. | A moving phone gives a wrong conversion. Save the door while the phone is held still, and average several readings. |
| `"provider": "reactvision"` may disturb what works today. | First check of step 3. |
| The library changes fast (seven releases in six weeks, 3.2.0 broke compatibility). | Keep the version pinned at 3.2.2 until the comparison is done. |
| Interior recordings go to the vendor's cloud. | The vendor says it keeps the recording only while it processes it. How long maps are kept and who owns them is not stated. Venues that refuse this stay on our server. |
| Limits of the service. | 10 scans a day per user and 3 unfinished scans at a time. An upload limit of 512 MiB was seen in one reading of the limits page and not in another. |

## 8. Not verified

Nothing was run on a phone, and no call was made to the service.

- How long a scan is processed and how long recognising the place takes.
- Whether recognising an existing place keeps working if the plan is cancelled.
- Where the origin and the axes of the map frame come from.
- Whether the recording our app makes is accepted as it is (the same library calls are used, but nobody has uploaded one).
- Whether `"provider": "reactvision"` disturbs our recording and the depth mesh.
- Whether the portal works when the door is driven by `renderPose`.
- Accuracy and repeatability in a room; the vendor publishes no room figures.
- Whether a scan can be uploaded from our server with the secret key.
- Whether StudioGo, the vendor's scanning app, exists for Android.
- How long maps are kept and what the terms say about ownership of the data.

## 9. Sources

- The owner's decision of 2026-11-21 and the task for the chats: `rework_two_modes_brief.md` in the shared notes folder.
- The review of the service for the owner: `reports/advanced-vps-review.md` (not published).
- Library source: `app/node_modules/@reactvision/react-viro` 3.2.2, files named in the text.
- Vendor pages, read 2026-11-21:
  - https://viro-community.readme.io/docs/advanced-vps-and-scanning
  - https://viro-community.readme.io/docs/advanced-vps-setup
  - https://viro-community.readme.io/docs/advanced-vps-in-your-app
  - https://viro-community.readme.io/docs/virovps
  - https://viro-community.readme.io/docs/authentication
  - https://viro-community.readme.io/docs/client-keys
  - https://viro-community.readme.io/reference/app-user-tokensmint
  - https://viro-community.readme.io/docs/reactvision-studio-setup
  - https://viro-community.readme.io/reference/limits
  - https://www.reactvision.xyz/pricing/
  - https://github.com/ReactVision/viro/releases

The vendor pages were read through a tool that returns summaries, so menu names and field names should be checked against the live pages while doing the steps.

## 10. An earlier variant in the repository

Before the owner's decision this chat had prepared the other free candidate, Google ARCore Cloud Anchors, as code: `app/src/localization/cloud/` (commit `8d1d981`). It is not connected to the app and nothing imports it. Whether it stays as a spare or is removed is for the owner and the dispatcher to decide. Its frame arithmetic (`core/anchorMath.ts`, a pose written relative to another frame, with unit tests) is the same arithmetic as in section 5.
