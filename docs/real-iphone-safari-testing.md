# Real iPhone Safari Testing

Use this workflow to verify WebGPU behavior on a physical iPhone rather than relying only on desktop Safari or a simulator.

## One-Time Device Setup

1. Connect the iPhone to the Mac with a USB cable.
2. Unlock the iPhone and trust the Mac when prompted.
3. On the iPhone, enable `Settings > Apps > Safari > Advanced > Web Inspector`.
4. On the Mac, enable `Safari > Settings > Advanced > Show features for web developers`.
5. In Mac Safari, open `Develop > Inspect Apps and Devices`.
6. Select the iPhone. A working setup shows Safari pages from the phone instead of `Device is not paired`.

## Start The App

From the project directory, run:

```sh
npm install
npm run prepare-runtime
node server.js
```

The server prints the current LAN URLs. Keep that terminal open while testing.

## Trust The Local Certificate

iPhone Safari requires trusted HTTPS before exposing WebGPU to a page loaded from another device.

1. Find the Mac's LAN address in the server output.
2. On the iPhone, open:

   ```text
   http://<mac-lan-ip>:8080/certs/ios-webml-ca.mobileconfig
   ```

3. Allow the configuration profile download.
4. Open `Settings > General > VPN & Device Management`.
5. Select `iOS WebML Development CA` and install it.
6. Open `Settings > General > About > Certificate Trust Settings`.
7. Enable full trust for `iOS WebML Development CA`.
8. Return to Safari and open:

   ```text
   https://<mac-lan-ip>:8443/
   ```

The profile contains only the public CA certificate. Private keys remain under the local `certs/` directory and are excluded from Git.

## Inspect The iPhone Page

1. Keep the iPhone unlocked with Safari in the foreground.
2. Open the HTTPS LAN URL in iPhone Safari.
3. On the Mac, open `Safari > Develop > Inspect Apps and Devices`.
4. Select the iPhone and open the listed Safari page.
5. Use `Console` for runtime errors and WebGPU checks.
6. Use `Network` for model, tokenizer, and shader requests.
7. Use `Storage` for cache state.
8. Use `Timelines` for expensive loading or inference work.

The development server also prints forwarded browser diagnostics in its terminal.

## Memory-Safe Model Check

1. Close other tabs running this app.
2. Open the HTTPS app URL in one iPhone Safari tab.
3. Select **Load model** and keep Safari in the foreground.
4. Confirm loading reaches **Ready** without Safari reloading or closing the page.
5. Send a short prompt and confirm text is generated.
6. Open the same URL in a second tab and select **Load model**.
7. Confirm the second tab reports that another tab owns the model instead of
   starting a second download.
8. Return to the first tab, use the unload button, then retry in the second tab.
9. Confirm the second tab can now load the model.

On iPhone, the app uses one download lane with 32 MiB pieces. The oversized
embedding is written to origin-private file storage. Inference reads only the
rows needed for the current tokens into a compact GPU cache, so Safari never
needs the full 1.1 GiB table in resident GPU memory.

## Verified Physical-Device Result

The memory-safe path was verified on a physical iPhone running iOS 18.7 and
Safari 26.5.2:

- Secure context and WebGPU available
- Apple adapter limit: 1 GiB per buffer and storage binding
- Full 2.46 GB model load completed in 138.3 seconds
- No page reload past the previous 1.78 GB failure point
- Exact prompt response generated successfully
- Measured TTFT: 411 ms
- Measured generation rate: 20.7 tokens/second
- Explicit unload completed and released ownership
- Same page reacquired and returned to ready from cache in 6.0 seconds

## WebGPU Smoke Check

Run this in the inspected iPhone page's console:

```js
isSecureContext
"gpu" in navigator
await navigator.gpu.requestAdapter()
```

Expected results are `true`, `true`, and a `GPUAdapter` object.

## Troubleshooting

- `Device is not paired`: open the iPhone in Finder, select `Trust`, then confirm on the phone.
- `No inspectable contents`: unlock the iPhone and keep Safari in the foreground with the page open.
- iPhone Mirroring works but Safari inspection does not: USB trust and Safari Web Inspector are still required.
- The LAN page does not load: confirm both devices are on the same network and the macOS firewall permits Node.js connections.
- Safari reports that the network connection was lost: reinstall and fully trust the generated CA profile, then reopen the HTTPS URL.
- `navigator.gpu` is missing: verify the secure context first, then check the installed iOS/Safari version and relevant feature flags.
