# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    ok "the model client pod (sandbox image, gVisor) is ready"
    in_client() { $KUBECTL -n "$TEAM_NS" exec "$MODEL_CLIENT" -c client -- sh -c "$1" 2>&1 || true; }
    MODEL_SANDBOX=5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f
    model_token=$(mint kobe.model-gateway "$MODEL_SANDBOX" "$MODEL_USER_ID")
    egress_aud_token=$(mint kobe.egress-proxy "$MODEL_SANDBOX" "$MODEL_USER_ID")
    MG=http://model-gateway.kobe.internal:80
    # → the body, then "code=<status>".
    model_call() { # path json [header…]
      local path="$1" body="$2"
      shift 2
      local hdrs="" hh
      for hh in "$@"; do hdrs="$hdrs -H '$hh'"; done
      in_client "curl -s -m 30 -X POST $MG$path -H 'content-type: application/json' $hdrs -d '$body' -w '\ncode=%{http_code}\n'"
    }
    chat() { model_call /v1/chat/completions "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hello-e2e\"}]${3:-}}" "Authorization: Bearer $2"; }
    # Positive control and CNI warm-up: wait until the shim answers this pod at all.
    up=$(in_client "if $(retry "curl -s -o /dev/null -m 5 $MG/healthz" 120); then echo shim=ANSWERS; else echo shim=SILENT; fi")
    contains "control: the model-gateway shim answers the sandbox-like client" '^shim=ANSWERS$' "$up"
    contains "OpenAI: a sandbox calls a model through the shim with its token" 'fake-openai: hello-e2e' \
      "$(chat openai/gpt-fake "$model_token")"
    contains "OpenAI: streaming responses stream through" '^data: \[DONE\]' \
      "$(chat openai/gpt-fake "$model_token" ',"stream":true')"
    # KOBE-43: the shim forced stream_options.include_usage on that streaming call (it sent none),
    # and Bifrost passed it on to the provider.
    contains "the provider was asked for the stream's usage report (include_usage forced)" \
      '"includeUsage":true' "$(probe "$NS" "$(answers "$LLM/_seen")")"
    contains "Anthropic native (x-api-key): answered by the Anthropic upstream" 'fake-anthropic: hello-e2e' \
      "$(model_call /anthropic/v1/messages '{"model":"anthropic/claude-fake","max_tokens":16,"messages":[{"role":"user","content":"hello-e2e"}]}' \
        "x-api-key: $model_token" 'anthropic-version: 2023-06-01')"
    contains "Gemini (x-goog-api-key): answered by the Gemini upstream" 'fake-gemini: hello-e2e' \
      "$(model_call /genai/v1beta/models/gemini/gemini-fake:generateContent '{"contents":[{"role":"user","parts":[{"text":"hello-e2e"}]}]}' \
        "x-goog-api-key: $model_token")"
    contains "Ollama: answered through Bifrost's Ollama provider" 'fake-openai: hello-e2e' \
      "$(chat ollama/llama-fake "$model_token")"
    contains "OpenAI-compatible (vLLM): answered through a custom provider" 'fake-openai: hello-e2e' \
      "$(chat kobe-vllm/qwen-fake "$model_token")"
    contains "a call without a token is refused (401)" '^code=401$' \
      "$(model_call /v1/chat/completions '{"model":"openai/gpt-fake","messages":[]}')"
    contains "a forged token is refused (401)" '^code=401$' "$(chat openai/gpt-fake forged.token.value-xxxxxxxxxx)"
    contains "another audience's token (egress proxy) is refused (401)" '^code=401$' \
      "$(chat openai/gpt-fake "$egress_aud_token")"
    contains "a model outside the team's enabled models is refused (403)" '^code=403$' \
      "$(chat openai/gpt-not-enabled "$model_token")"
    contains "Bifrost's admin API is not reachable through the shim (404)" '^code=404$' \
      "$(in_client "curl -s -m 10 -H 'Authorization: Bearer $model_token' $MG/api/providers -w '\ncode=%{http_code}\n'")"
    # Direct to Bifrost (bypassing the shim) is blocked; checked only after the shim answered.
    if [[ "$up" == *shim=ANSWERS* ]]; then
      direct=$(in_client "curl -s -m 8 -o /dev/null http://${bifrost_ip:-0.0.0.0}:8080/health && echo bifrost=REACHED || echo bifrost=BLOCKED")
    else
      direct="bifrost=UNTESTED"
    fi
    contains "the sandbox-like client cannot reach Bifrost directly" '^bifrost=BLOCKED$' "$direct"
    seen=$(probe "$NS" "$(answers "$LLM/_seen")")
    contains "provider keys reached the upstream (attached outside the sandbox)" 'e2e-provider-key-anthropic' "$seen"
    if printf '%s' "$seen" | grep -Eq 'sk-bf-|e2e-[0-9]|eyJ'; then fail "no sandbox credential or virtual key reached the provider"
    else ok "no sandbox credential or virtual key reached the provider"; fi

    # Bifrost itself, bypassing the shim (which also refuses disabled models on its own): from a
    # server pod, with the model user's virtual key as the sync stored it → "code=<status>".
    bifrost_direct() { # model
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
        const db = await import('/app/node_modules/@kaiju/db/dist/index.js');
        const d = db.createDb(process.env.KOBE_DATABASE_URL);
        try {
          const rows = await db.withTeam(d.db, '$E2E_TEAM_ID', (tx) => tx.select().from(db.modelGatewayKeys)
            .where(db.eq(db.modelGatewayKeys.userId, '$MODEL_USER_ID')));
          const box = new db.SecretBox([process.env.KOBE_MODELS_VIRTUAL_KEY_SECRET], db.VIRTUAL_KEY_PURPOSE);
          const vk = box.open(rows[0].vkValueEnc, db.virtualKeyContext('$E2E_TEAM_ID', '$MODEL_USER_ID'));
          const r = await fetch('http://kobe-bifrost:8080/v1/chat/completions', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bf-vk': vk }, signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ model: process.argv[1], messages: [{ role: 'user', content: 'hi' }] }) });
          console.log('code=' + r.status);
        } catch (e) { console.log('error=' + e.message); } finally { await d.close(); }
      " "$1" 2>&1 | tail -1
    }
    until_bifrost() { # expected-code model [seconds]
      local out="" end=$((SECONDS + ${3:-20}))
      while :; do
        out=$(bifrost_direct "$2")
        if [[ "$out" == "code=$1" ]] || ((SECONDS >= end)); then break; fi
        sleep 1
      done
      printf '%s\n' "$out"
    }
    until_code() { # expected-code model token [seconds]
      local out="" end=$((SECONDS + ${4:-20}))
      while :; do
        out=$(chat "$2" "$3")
        if grep -q "^code=$1$" <<<"$out" || ((SECONDS >= end)); then break; fi
        sleep 1
      done
      printf '%s\n' "$out"
    }
    contains "control: Bifrost answers the member's virtual key for an enabled model" '^code=200$' \
      "$(until_bifrost 200 kobe-vllm/qwen-fake)"
    # ac-1: a team admin change reaches Bifrost within 10 s (LISTEN/NOTIFY → sync → admin API).
    contains "the team disables a model through the team API" '^200 ' "$(as_owner "PUT /v1/team/models/qwen {\"enabled\":false}")"
    t0=$SECONDS
    disabled=$(until_bifrost 403 kobe-vllm/qwen-fake)
    elapsed=$((SECONDS - t0))
    contains "Bifrost refuses the disabled model (pushed by the sync)" '^code=403$' "$disabled"
    if ((elapsed <= 10)); then ok "the change reached Bifrost within 10 s (${elapsed}s)"
    else fail "the change reached Bifrost within 10 s (took ${elapsed}s)"; fi
    contains "the shim refuses the disabled model too (its own enablement check)" '^code=403$' \
      "$(chat kobe-vllm/qwen-fake "$model_token")"
    # Fail closed: the team's last model disabled → Bifrost refuses everything for the key.
    expect "the team disables its remaining models" '^200 ' "$(as_owner \
      "PUT /v1/team/models/fast {\"enabled\":false}" "PUT /v1/team/models/smart {\"enabled\":false}" \
      "PUT /v1/team/models/gem {\"enabled\":false}" "PUT /v1/team/models/local {\"enabled\":false}")"
    contains "with nothing enabled, Bifrost refuses a previously enabled model (key deactivated)" '^code=403$' \
      "$(until_bifrost 403 openai/gpt-fake)"
    as_owner "PUT /v1/team/models/fast {\"enabled\":true}" >/dev/null
    contains "re-enabling a model restores access through the shim" 'fake-openai: hello-e2e' \
      "$(until_code 200 openai/gpt-fake "$model_token" 30)"

