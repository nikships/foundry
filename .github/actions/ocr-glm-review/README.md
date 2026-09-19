# SPDX-License-Identifier: Apache-2.0

# OCR code review with GLM 5.3 Flash (max reasoning)

Reusable composite action: runs [Alibaba Open Code Review](https://github.com/alibaba/open-code-review)
on a pull request using Z.ai **GLM 5.3 Flash at max reasoning** through **OpenRouter**,
routed **cheapest-first**.

## Why this wrapper exists

The upstream `alibaba/open-code-review` action is model-agnostic and its
default `llm_extra_body` **disables thinking mode**. This wrapper fixes the
model + routing + reasoning defaults so every consumer gets the same setup:

- Model `z-ai/glm-5.3-flash`, `reasoning.effort: max` (OpenRouter-native) plus
  OCR's `reasoning_effort: max` merge, temperature 1.0 / top_p 0.95 per Z.ai.
- Provider routing `sort: "price"` with fallbacks on: always cheapest-first.
- **No `quantizations` filter by design.** Every live GLM 5.3 Flash endpoint on
  OpenRouter reports fp8, fp4, nvfp4, or unknown — there is no full-precision
  endpoint to prefer, so filtering only excludes cheap endpoints.
- Review behaviour tuned for PR signal over noise: high effort, sticky summary,
  incremental posting, checkpoint ranges, outdated-thread reporting.

## Use it from any repo

```yaml
jobs:
  ocr-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: nikships/foundry/.github/actions/ocr-glm-review@main
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

Pin `@main` to a SHA for supply-chain strictness.
`resolve_outdated` defaults to `report`; pass `true` (and grant
`contents: write`) to actually resolve outdated threads.

## Secrets

| Secret               | Where to set it                               |
| -------------------- | --------------------------------------------- |
| `OPENROUTER_API_KEY` | Calling repo (or org) secrets, passed through |

## Inputs

| Input                                 | Default              | Notes                                                                  |
| ------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `openrouter_api_key`                  | (required)           | Secret, never logged.                                                  |
| `model`                               | `z-ai/glm-5.3-flash` | Any OpenRouter slug.                                                   |
| `reasoning_effort`                    | `max`                | `max`, `high`, or `low`.                                               |
| `provider_sort`                       | `price`              | `price` = strict cheapest-first; empty = OpenRouter default balancing. |
| `provider_order`                      | `''`                 | CSV provider slugs tried first, e.g. `"z-ai,deepinfra"`.               |
| `provider_ignore`                     | `''`                 | CSV provider slugs to skip.                                            |
| `allow_fallbacks`                     | `true`               | Keep true so an outage on the cheapest provider fails over.            |
| `language`                            | `English`            | Review output language.                                                |
| `effort`                              | `high`               | OCR review depth: `low`, `medium`, `high`.                             |
| `sticky_summary`                      | `true`               | Update the summary comment in place.                                   |
| `incremental`                         | `true`               | Only post non-overlapping inline comments.                             |
| `resolve_outdated`                    | `report`             | `false`, `report`, or `true`.                                          |
| `checkpoint_range`                    | `true`               | Review only new pushes since the last checkpoint.                      |
| `full_review`                         | `false`              | Force one full review.                                                 |
| `upload_artifacts`                    | `true`               | Upload raw JSON result and stderr.                                     |
| `ocr_version`                         | `latest`             | npm spec for the OCR CLI.                                              |
| `github_token`                        | `github.token`       | Token used to post comments.                                           |
| `base_ref` / `head_sha` / `pr_number` | `''`                 | Range overrides for non-PR triggers.                                   |

## Outputs

`comments_total`, `comments_inline`, `comments_skipped`, `comments_failed`,
`summary_comment_url` (all passed through from upstream).
