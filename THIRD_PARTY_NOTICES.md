# Third-Party Notices

## Gemma 4 WebGPU Runtime

The runtime bundle is not distributed in this repository. The preparation
script downloads `gemma-4-e2b.js` from the
[WebML Community Gemma 4 WebGPU Kernels Space](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels),
verifies the exact upstream bytes, and applies this project's memory-safety
patch locally.

SHA-256:

```text
0234c0e866bfaa9623e938a7cfa7f5740cca22532cc1112dd4e8915b97f78d62
```

The prepared local runtime has SHA-256:

```text
e6f785d053fc13d149b149fed72948d0225bcac4d66094abdc9d24c14c677d18
```

The upstream Space does not currently declare a license in its repository
metadata. No additional license is granted here for that third-party bundle,
and neither the upstream nor prepared runtime is committed to this repository.
The GitHub Pages artifact also excludes both bundles; visitors fetch the
hash-pinned source directly from its upstream host for in-browser patching.
Consult the upstream project before redistributing or incorporating it elsewhere.

## js-beautify

The browser loader includes the minified JavaScript formatter from
`js-beautify` 2.0.3. It is distributed under the MIT License; see
`vendor/LICENSE.js-beautify`. The vendored browser file and license are included
in the GitHub Pages artifact.

## es-module-lexer

The browser loader includes `es-module-lexer` 2.3.1 to enumerate and validate
every module dependency before Blob import. It is distributed under the MIT
License; see `vendor/LICENSE.es-module-lexer`. The vendored browser module and
license are included in the GitHub Pages artifact.

## Gemma Model

The app downloads `google/gemma-4-E2B-it-qat-mobile-transformers` from Hugging Face at runtime. Model files are not included in this repository. The model page identifies its license as Apache 2.0; review the [model card](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers) for current terms and usage guidance.

Gemma and related marks belong to their respective owners. This repository is an independent development and testing project.
