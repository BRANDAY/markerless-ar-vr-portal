# Connecting a ready-made cloud service as a second way to hold the door

State as of 2026-11-21. The self-hosted server stays the main way to find the doorway. This document covers the second way: an existing cloud positioning service that keeps the door in place when there is no PC with our server in the venue. We do not build a cloud of our own.

**Decision:** Google ARCore Cloud Anchors, called through the functions that ViroReact 3.2.2 already has. It costs nothing, needs no native module of ours, and an anchor can live up to 365 days. The door opening is still found by our server (or placed by hand) once; the cloud only remembers where that was.

Nothing here has run on a phone yet. The code is written and unit-tested; the list of what must be checked on the device is in section 8.

## 1. What a cloud service can and cannot do for us

Every service looked at returns one of two things: the pose of the phone in a map, or the pose of an anchor that was saved earlier. None of them finds a door opening. So with any cloud service the doorway has to be decided once by something else, and the cloud keeps that decision:

- **(a) the server finds the opening, the cloud remembers it.** The staff scans the room as today, our server finds the real opening, and the doorway that appears is saved as a cloud anchor. Visitors' phones then need internet, not the server.
- **(b) the door is placed by hand, the cloud remembers it.** No server at all. The door stands where the staff put it, so it fits the real opening only as well as the hand placement did.

Both go through the same "Save door to cloud" step, and the code supports both. Path (a) is the one to build the interface around, because it keeps what only our product has: a door that sits in the real opening with the real size.

## 2. What ViroReact 3.2.2 really provides

Checked in the installed package `app/node_modules/@reactvision/react-viro` (version 3.2.2). Paths are relative to the package root.

| What | Where | Notes |
|---|---|---|
| `hostCloudAnchor(anchorId, ttlDays = 1)` | `components/AR/ViroARSceneNavigator.tsx:1042-1051` | Uploads an anchor that already exists in the session. `ttlDays` is clamped to 1..365 in JS. |
| `resolveCloudAnchor(cloudAnchorId)` | same file, `:1063-1070` | Returns `{ success, anchor?, error?, state }`. |
| `getCloudAnchorStatus()`, `cancelCloudAnchorOperations()` | same file, `:1081-1095` | Progress of a resolve; cancel everything. |
| Result types and the state names | `components/Types/ViroEvents.ts:462-551`, `:718-739` | `anchor.position` is in world coordinates, `anchor.rotation` in degrees. States include `ErrorNotAuthorized`, `ErrorCloudIdNotFound`, `ErrorResolvingLocalizationNoMatch`, `ErrorAnchorExpired`. |
| Which service is used | `components/Types/ViroEvents.ts:504`: `ViroProvider = "none" \| "arcore" \| "reactvision"` | Set by the `provider` prop of `ViroARSceneNavigator`; when it is missing the default is `"reactvision"` (`ViroARSceneNavigator.tsx:2342-2345`). The JS calls are the same for both services. |
| Where the calls live | `ViroARSceneNavigator.tsx:2093-2175` | On the `arSceneNavigator` object every scene receives as a prop. Our scene already hands it to providers (`app/src/ar/PortalARScene.tsx:135`). |
| Making a local anchor | `components/AR/ViroARScene.tsx:368-449` | There is **no** call that creates an anchor at an arbitrary pose. The way is a hit test (`performARHitTestWithWorldPoints` and others) followed by `createAnchoredNode(hitResult)`, which returns `{ anchorId?, transform? }`. Detected planes also carry an `anchorId` (`onAnchorFound`). |
| Build settings (Expo config plugin) | `plugins/withViroAndroid.ts:375-386` | `googleCloudApiKey` is written to the manifest as `com.google.android.ar.API_KEY`; `rvApiKey`, `rvProjectId` as `com.reactvision.RVApiKey`, `com.reactvision.RVProjectId`. |
| Location permissions | `plugins/withViroAndroid.ts:391-407` | Added when the plugin option `provider` is `"arcore"` or `"reactvision"`. Cloud anchors do not need them; see section 6. |
| Keys at run time | not found | Cloud anchor credentials are read from the manifest by native code. Only the VPS REST helpers accept credentials from JS (`components/AR/ViroVPSClient.ts:64-90`). |
| ReactVision VPS | `components/AR/ViroVPS.tsx`, `ViroVPSClient.ts`, navigator methods `uploadScanRecording`, `loadVPSMap`, `getVPSLocalization` | Present. `PAID_PLAN_REQUIRED` is named in `components/AR/ViroVPS.tsx:41`. |

The Android side of the package is prebuilt (`android/*/*.aar`), so what the native code does with these calls cannot be read. The ARCore client inside is `arcore_client/core-1.43.0.aar`.

Our app today is built with `"provider": "none"` (`app/app.json`), and no cloud call is used anywhere in `app/src`.

## 3. The candidates, by the same questions

Prices and terms were read on the vendors' pages on 2026-11-21; sources are in section 9.

| | ARCore Cloud Anchors (Google) | ReactVision Cloud Anchors | ReactVision Advanced VPS | MultiSet | Immersal |
|---|---|---|---|---|---|
| Work to connect | Small. JS calls are in ViroReact. Build settings plus one Gradle dependency for long-lived anchors. | Smallest. Same JS calls, two keys in the build. | Medium. Own scan upload and map flow, new components (`ViroVPS`, `ViroVPSAnchor`). | Large. Native Android SDK, so a native module of our own. | Large, and the Android SDK is given on request only. |
| Price for one venue | No price published; nothing found that asks for payment. | Free plan: 1,000 Spatial API requests per month. | Basic plan $25/month, plus $0.60/min for map processing and server localisation. | Free: 1,000 calls for the lifetime of the account. Then from $99/month. | Free plan for small maps; commercial use from $99/month. |
| How long the binding lasts | 24 hours with an API key. 1 to 365 days with keyless authorisation. | `ttlDays` 1..365 in the call; whether more than 1 day works with a client key is not stated. | Map retention not stated. | Not checked. | Not checked. |
| Needed from the owner | Google account, a Cloud project, ARCore API switched on, one credential. | Studio account, project, client key. | Studio account, paid plan, card. | Account, key. | Account, request for the SDK. |
| What goes to the cloud | Visual features around the anchor and device poses. Raw upload is discarded within 24 hours; the processed map stays at Google. | Keyframes turned into 3D points and SIFT descriptors. Region not stated; US, UK or EU. | A recording of the room (video and poses). | Map of the venue. | Map of the venue. |
| Who stands behind it | Google. Deprecation policy promises a year of notice. | Small company; cloud anchors fixes were still landing in 3.2.1 (2026-11-18). | Same company; feature released 2026-11-08. | Start-up. | Hexagon. |

**Why ARCore Cloud Anchors.** It is free, it is the service least likely to disappear without notice, and it is already reachable from our app without native code. Its one weak point, the 24-hour lifetime with an API key, has a documented way around it (keyless authorisation, 365 days).

**Why not the others, for now.**
- *ReactVision Cloud Anchors* is the fallback. Our code works with it unchanged, because ViroReact uses the same two calls for both services. Switching is a build setting. It is second only because the service is young and its lifetime rules are not written down.
- *ReactVision Advanced VPS* is the only candidate that maps the whole room, which would survive a changed doorway area better than one anchor. It costs money from the first scan, is two weeks old, and repeats what our own server does. Worth a separate trial only if anchors turn out not to hold.
- *MultiSet and Immersal* need a native module and a paid plan for real use. Not justified while a free path exists in the library we already ship.

## 4. How the door gets into the opening

### Saving (staff, once per room)

1. The room is scanned as today and the door appears in the real opening (self-hosted provider). Without a server, the door is placed by hand instead.
2. The staff member taps **Save door to cloud**.
3. The screen asks to walk slowly around the doorway for about half a minute, looking at the floor and the walls next to it. The service builds its picture of the place from what the camera saw around the anchor.
4. The app makes an AR anchor on the floor under the doorway, uploads it, and looks it up once to make sure it can be found. The screen shows "Saving…", then "Checking…".
5. Result: "Saved. Works without the server until 21 Nov 2027", or a plain reason why not (no internet, too little seen, the build is not registered with Google).

What the phone keeps is small: the id of the cloud anchor, the doorway pose relative to that anchor, the size of the opening, and the expiry date (`cloud-door.json` in the app's private storage). No key is stored.

### Finding (every later session)

1. The app starts with the cloud provider. Status: "Looking for the saved doorway — look at the wall and floor around it".
2. The service finds the anchor from the camera view. The app rebuilds the doorway from the saved offset and shows the door, with the opening size the server measured.
3. If the place is not recognised, the app tries again a limited number of times and then tells the user where to stand. After a loss of tracking the door stays on screen, is marked as not trusted, and is looked for again. These are the same rules the self-hosted provider follows.

Visitors do nothing extra. Their phone needs internet at that moment.

### Limits of this way

- One anchor remembers one spot. If the area around the doorway changes a lot (new furniture, very different light), the anchor may not be found and the door has to be saved again.
- The door is only as right as it was when saved. A wrong opening from the server is remembered wrong.
- The saved record lives on the phone that made it. Other phones of the venue need a copy; see section 7.

## 5. What the owner has to do

Nothing below was done for you: no account was created, no terms were accepted, no key was made.

Cost: **0**. No Google page read on 2026-11-21 names a price for the ARCore API. Whether the Cloud project needs a billing account was not confirmed; if the console asks for a card, stop and tell me.

1. Open https://console.cloud.google.com with a Google account. Create a project, for example `ar-portal`. Google will ask to accept its Cloud terms.
2. In **APIs & Services → Library**, find **ARCore API** and press **Enable**.
3. **For the first test (anchors that live 24 hours).** In **APIs & Services → Credentials**, press **Create credentials → API key**. Then restrict the key:
   - Application restriction: **Android apps**, package `hr.fesb.arportal`, SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`.
   - API restriction: **ARCore API** only.
4. **For anchors that live up to 365 days (keyless).** In the same place press **Create credentials → OAuth client ID**. If the console first asks to set up the consent screen, give an app name and your e-mail; no scopes are needed. Then choose application type **Android**, package `hr.fesb.arportal`, the same SHA-1. There is nothing to copy from this step: Google recognises the app by its package and signature.
5. Put the API key from step 3 into a local file that git ignores, `app/src/localization/cloud/cloud-keys.local.json`:
   ```json
   { "googleCloudApiKey": "paste the key here" }
   ```
   The shape is shown in `cloud-keys.example.json` next to it. Do not paste the key into a chat or into any other file.

About the SHA-1: it is the fingerprint of the debug keystore every React Native project is generated with (`app/android/app/debug.keystore`). It is public, so the restriction in step 3 only stops casual misuse. Before the app goes to a venue it needs its own signing key, and steps 3 and 4 have to be repeated with that key's SHA-1.

## 6. Plan for the app chat

Code that exists (new files only, `app/src/localization/cloud/`):

| File | What it is |
|---|---|
| `CloudAnchorDoorProvider.ts` | The provider (`id: 'arcore-cloud-anchor'`). Reads the saved record, finds the anchor, emits the doorway. |
| `saveDoorToCloud.ts` | What the "Save door to cloud" button calls. |
| `doorRecordStore.ts` | The record file on the phone. |
| `core/resolveSession.ts` | Rules of finding and keeping the door (attempts, time limits, tracking loss). |
| `core/saveDoor.ts` | Steps of saving: local anchor, upload, check, offset. |
| `core/cloudAnchorApi.ts` | Typed access to the ViroReact calls and the meaning of every failure state. |
| `core/localAnchor.ts` | Where the local anchor comes from: hit test under the doorway, or a detected plane. |
| `core/doorRecord.ts`, `core/anchorMath.ts` | The saved record and its expiry; the doorway relative to the anchor. |
| `core/*.test.ts` | 53 unit tests. |

Steps, in the order that finds problems earliest:

1. **Tests.** Add `"src/localization/cloud/core/**/*.ts"` to `include` in `app/tsconfig.test.json`, so `npm test` runs the 53 tests.
2. **Provider.** In `app/src/localization/index.ts` return `new CloudAnchorDoorProvider()` for `'arcore-cloud-anchor'` (import from `./cloud`) and add the id to `SELECTABLE_PROVIDER_IDS`. The stub class of the same id in `stubs.ts` is then unused.
3. **Build with an API key.** Read `googleCloudApiKey` from `app/src/localization/cloud/cloud-keys.local.json` in an `app.config.js` and pass it to the `@reactvision/react-viro` plugin. Keep the plugin option `"provider": "none"`: on Android that option only decides whether location permissions are added (`plugins/withViroAndroid.ts:391-407`), and cloud anchors do not need them. Set the service on the view instead: `<ViroARSceneNavigator provider="arcore" …>` in `App.tsx`.
4. **Save button.** In `PortalARScene.tsx` keep a ref to `ViroARScene` and build the anchor source once:
   `firstAnchorSource([hitTestAnchorSource(() => sceneRef.current, log), planeAnchorSource(() => planes)])`.
   The button calls `saveDoorToCloud({ navigator, anchors, door, opening, doorSource, roomId, log, onStep })` with the door pose that is on screen. The result says what to show.
5. **First device test, 24-hour anchors.** Save a door, close the app completely, start it with the cloud provider, see the door come back. This proves the whole chain apart from the lifetime.
6. **Keyless, 365 days.** Add the Gradle dependency `com.google.android.gms:play-services-auth` with a small config plugin (like `plugins/withAndroidBuildTuning.js`), build **without** `googleCloudApiKey`, save a door. `saveDoorToCloud` asks for 365 days and falls back to 1 day when that is refused, with a warning in the result, so the outcome is visible at once.
7. **Words on screen.** Google requires a notice where the feature is used: "To power this session, Google will process sensor data (e.g., camera and location)." with a "Learn more" link to https://support.google.com/ar?p=how-google-play-services-for-ar-handles-your-data. Where it goes belongs to the product spec (`docs/product/ui-spec.md`).

The status codes the provider sends reuse the existing ones (`no-room` for "nothing saved" and "anchor gone", `incompatible` for "build not registered", `server-offline` for "no internet", `not-recognised`, `unconfirmed`, `tracking-lost`). If the interface needs its own words for the cloud cases, new codes have to be added to `StatusMeta` in `types.ts`.

## 7. Risks and limits

| Risk | What follows |
|---|---|
| ViroReact's native ARCore path has never run in our app. | Step 5 above is the first thing to do. If it fails, try the same code with `provider="reactvision"`. |
| Keyless authorisation may not work through ViroReact (its native code may insist on an API key). | Anchors would last 24 hours only. Ways out: ReactVision Cloud Anchors with the same code, or a small native module of ours that calls ARCore's own hosting function. The app already has a local native module (`app/modules/wifi-route`). |
| Whether keyless needs a Google account signed in on the phone is not confirmed. | Matters for phones handed to visitors. Check on a phone without an account. |
| `hostCloudAnchor` may not accept the id that `createAnchoredNode` returns. | The code falls back to the id of a detected plane and measures the anchor pose by looking the anchor up. |
| ViroReact does not expose ARCore's "is enough seen to host" estimate. | The app cannot tell the staff when they have looked around enough; it can only ask for half a minute and report a failure. |
| The anchor expires after at most 365 days. | The door must be saved again once a year. The app warns 30 days before. Google has a server-side API that can extend the lifetime; using it needs a service account and is not built. |
| The room looks different later (light, furniture). | The anchor may not be found. Google advises against bare white walls and shiny surfaces. No published numbers; ours will come from the measurement protocol. |
| Features of the venue interior are stored at Google. | Must be said to the venue. Venues that refuse this stay on the self-hosted server, which is why it remains the main way. |
| Internet is needed on every visitor phone at start. | The self-hosted server needs only local Wi-Fi. |
| The saved record is on one phone. | `toShareText` / `fromShareText` turn it into one line of text. The simplest carrier is our own server: store the line with the room and hand it to every phone that connects once. That is a change for the server chat and is not done. |
| The cloud anchor id is not a secret, and the debug signing key is public. | With keyless authorisation, anyone who rebuilds the app with the debug key could look up our anchors. Use a private signing key for venue builds. |

## 8. Not verified

On the device (nothing was run on a phone):
- that `provider="arcore"` hosts and resolves at all in ViroReact 3.2.2 on the Xiaomi 14 Ultra;
- that a resolve right after hosting, in the same session, succeeds;
- how long hosting and resolving take, and how far the door lands from where it was saved;
- that the door holds when the app is started from another side of the room, in other light;
- keyless authorisation through ViroReact, with and without a Google account on the phone;
- that the build works with the plugin option `"provider": "none"` and the prop `provider="arcore"`.

In the documentation:
- Google's keyless steps for Android were read from search summaries of https://developers.google.com/ar/develop/authorization, not from the full page;
- whether the Cloud project needs a billing account;
- the rule for extending an anchor's lifetime through the Management API;
- how far away and at what angle an anchor can still be found; Google publishes no numbers;
- ReactVision: lifetime of anchors hosted with a client key, the 512 MiB recording limit, and the `403 PAID_PLAN_REQUIRED` answer were not found on the pages read today (the last one is named in the library source);
- MultiSet and Immersal terms were taken from the earlier survey and not read again.

## 9. Sources (read 2026-11-21)

Google:
- Cloud Anchors overview: https://developers.google.com/ar/develop/cloud-anchors
- Developer guide (lifetime with an API key, quotas of 30 host and 300 resolve requests per minute, upload discarded within 24 hours): https://developers.google.com/ar/develop/java/cloud-anchors/developer-guide
- Lifetime up to 365 days: https://developers.google.com/ar/reference/java/com/google/ar/core/Session
- Authorisation: https://developers.google.com/ar/develop/authorization
- Management API (list, delete, extend): https://developers.google.com/ar/develop/cloud-anchors/management-api
- Deprecation policy: https://developers.google.com/ar/develop/cloud-anchors/cloud-anchor-deprecation-policy
- Required user notice: https://developers.google.com/ar/develop/privacy-requirements
- Data handling: https://developers.google.com/ar/data-privacy

ReactVision:
- Pricing: https://www.reactvision.xyz/pricing/
- Cloud anchors: https://viro-community.readme.io/docs/cloud-anchors
- Keys and project: https://viro-community.readme.io/docs/reactvision-studio-setup, https://viro-community.readme.io/docs/authentication
- Advanced VPS: https://viro-community.readme.io/docs/advanced-vps-and-scanning
- Terms and privacy: https://www.reactvision.xyz/policies/terms-of-service/, https://www.reactvision.xyz/policies/privacy-policy/
- Releases: https://github.com/ReactVision/viro/releases

Earlier surveys in this repository: `docs/research/tools-comparison.ru.md` (2026-11-20) for MultiSet, Immersal and Niantic.
