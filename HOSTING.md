# Firebase Hosting

Hosting stages only `assets/`, `css/`, `js/`, and `lib/` into ignored
`hosting-dist/`, preserving their paths and file contents. It does not publish
the repository root. Firestore configuration remains unchanged. There are no
SPA rewrites, redirects, or backend integrations.

From the repository root, with Node.js installed:

```sh
node scripts/build-hosting.cjs
node scripts/validate-hosting.cjs
```

The build deletes stale generated output, rejects symbolic links and unsupported
file extensions, excludes hidden/private/local configuration names before reading
them, and rejects common credential signatures without printing matched contents.
It does not load environment files. The generated files are byte-for-byte copies.
Public Firebase browser configuration is intentionally included; Firebase Admin
credentials and backend configuration must never be placed in frontend files.
Signature scanning cannot prove the absence of every possible secret, so changes
to frontend configuration still require review.

The monitoring timeline and severity chart use existing `waste-detection-timeline.js`
and `evaluation-severity-trends.js`. The unused commented signup link was removed;
no signup page exists. `Admin-Dashboard.html` retains its optional
`runtime-config.local.js` override with an error handler. The staging script excludes
that local file, and the validator recognizes only this exact optional reference;
missing required files still fail validation. Do not put private secrets into any
browser configuration, including local overrides. Dynamic paths and external services are outside
this static validation. Browser login and camera authorization need separate
live validation. The AI backend meta configuration remains unchanged.

For local static preview (no deployment):

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory hosting-dist
```

Visit `/lib/monitoring/Monitoring-Login.html` and
`/lib/monitoring/Waste-Management.html`. There is no root `index.html`; use these
explicit page paths. Local previews continue using the existing Firebase project.

When deployment is separately authorized, install/authenticate the Firebase CLI,
then run from the repository root:

```sh
firebase deploy --only hosting --project riversight-220d9
```

The Hosting predeploy hook rebuilds the output automatically. This command deploys
Hosting only, without deploying Firestore rules/indexes or changing Railway.
No deployment was performed as part of this setup.
