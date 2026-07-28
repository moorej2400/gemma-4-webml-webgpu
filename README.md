# Gemma 4 WebGPU Chat

On-device AI chat that runs directly in a supported web browser.

[**Open the live app**](https://moorej2400.github.io/gemma-4-webml-webgpu/)

This project pairs Gemma 4 with custom WebGPU kernels, a focused chat interface, and a practical way to test the experience on a real iPhone. Conversations stay in the browser; the model files are downloaded from Hugging Face when you load the model.

> **Project status:** Verified on a physical iPhone with local generation at
> 20.7 tokens/second. Browser support, free device storage, and available memory
> still determine whether the model can load successfully.

## Public Requirements

The live app requires a browser with WebGPU and Web Locks, sufficient available
memory, and enough storage or cache capacity for the model. The first model load
downloads ~2.4 GB from Hugging Face; later loads may use the browser cache.

## What It Does

- Runs Gemma 4 locally through WebGPU
- Streams responses into a mobile-friendly chat interface
- Shows model-loading and generation performance
- Supports secure testing over your local network
- Sends diagnostics to the development server only from approved local hosts

## Try It Locally

You need a current version of Node.js and a browser with WebGPU support.

Install dependencies and start the local server:

```sh
npm install
node server.js
```

Then open `http://localhost:8080` on the same computer and send a message.

The first message verifies and patches the runtime in the browser, then
downloads the model from Hugging Face. Later loads may use the browser cache.

The app does not load the runtime or model at page boot. Only one tab can own
the model at a time, which prevents two Safari pages from exhausting an
iPhone's memory.

## Test On iPhone

iPhone testing requires local HTTPS and trusting a development certificate generated on your own Mac. Follow the [real iPhone Safari testing guide](docs/real-iphone-safari-testing.md).

## Learn More

- [Technical overview](docs/technical-overview.md)
- [Runtime preparation](docs/runtime-preparation.md)
- [Real iPhone Safari testing](docs/real-iphone-safari-testing.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Privacy

Chat prompts and generated replies are processed in the browser. The public site
does not collect prompts, generated text, or application telemetry. Its debug
client exits before installing diagnostics.

On `localhost`, `127.0.0.1`, `::1`, and private LAN IPv4 addresses, the debug
client sends console, error, network, device, and lifecycle diagnostics to the
local development server. The server records them in a local `debug.log`; that
file and all generated certificates are excluded from Git.
