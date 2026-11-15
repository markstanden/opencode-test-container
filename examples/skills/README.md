# Skill-only example

A minimal, self-contained skill bundle and suite. It needs no docs plugin and
no judge. Run it against any image containing the scripted provider route:

```sh
otc validate --campaign examples/skills/campaign.json
```

The campaign names `localhost/otc-sandbox:2.2.6`; build it with the arguments
in `container/README.md`, or replace the image with one you already trust.
`SCRIPTED_API_KEY` is a placeholder for the offline provider, never a real
credential.
