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

Known existing path issues reported by the validator:

- `Monitoring-Login.html` links to absent `Monitoring-SignUp.html`.
- `Incident-Evaluation.html` references absent `severity-trends-module.js`.
- `Waste-Management.html` references absent `detection-timeline-module.js`.
- `Admin-Dashboard.html` references excluded optional `runtime-config.local.js`.

These references have not been changed. The manual validator exits unsuccessfully
until missing references are resolved; staging and Hosting's predeploy build
still succeed. Resolve the three missing page/module references before relying
on the affected functionality. Dynamic paths and external services are outside
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
