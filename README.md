# x402-ap2

**AP2를 x402 extension으로 구현한 TypeScript SDK.** — BAY 4th Team Project: x402 with AP2

x402 protocol은 그대로 두고, AP2 mandate를 x402 `extensions.ap2` 칸에만 실어 보낸다.
EIP-3009 `nonce = keccak256(paymentMandate)`로 두 계층을 묶어서, mandate 없이는 송금을 정산할 수 없게 만든다.

| 계층 | 역할 | 담는 곳 |
| --- | --- | --- |
| **x402** (base) | 돈을 어떻게 옮기나: 402 challenge, EIP-3009 서명, facilitator 정산 | `accepts`, `payload`, `PAYMENT-RESPONSE` |
| **AP2** (extension) | 이 결제를 할 권한이 있나: merchant 서명 cart, 사용자→agent 위임 mandate | `extensions.ap2` |

## 흐름

<table>
<tr>
<td valign="top">

```
 Agent            Merchant         Facilitator
   │                 │                  │
   │────── 1 ───────▶│                  │
   │◀───── 2 ────────│                  │
   3                 │                  │
   4                 │                  │
   5                 │                  │
   │────── 6 ───────▶│                  │
   │                 7                  │
   │                 │─────── 8 ───────▶│
   │                 │◀────── 9 ────────│
   │◀───── 10 ───────│                  │
```

</td>
<td valign="top">

| # | 계층 | 동작 |
| --- | --- | --- |
| 1 | x402 | `GET /resource` (결제 없이 요청) |
| 2 | x402 + **AP2** | `402` 응답. `PAYMENT-REQUIRED`의 `accepts`에는 금액·수취인(x402), `extensions.ap2`에는 merchant가 서명한 cart `checkoutJwt`(AP2) |
| 3 | **AP2** | cart를 사용자 제약과 대조 (human-present면 사용자가 직접 승인) |
| 4 | **AP2** | `checkoutMandate`·`paymentMandate` 생성. 사용자 → agent SD-JWT 위임 chain |
| 5 | x402 ⇄ **AP2** | EIP-3009 송금 서명. `nonce = keccak256(paymentMandate)`로 두 계층을 묶음 |
| 6 | x402 + **AP2** | `PAYMENT-SIGNATURE`로 재요청. `payload`에는 송금 서명(x402), `extensions.ap2`에는 mandate 두 개(AP2) |
| 7 | **AP2** | merchant가 mandate chain·제약·cart 일치·nonce binding 검증 |
| 8 | x402 | facilitator `/verify` → handler 실행 → 성공 시에만 `/settle` |
| 9 | x402 | on-chain `transferWithAuthorization` 실행, tx hash 반환 |
| 10 | x402 | `200` + `PAYMENT-RESPONSE`(정산 결과)와 함께 resource 전달 |

</td>
</tr>
</table>

extension을 모르는 x402 facilitator도 그대로 쓸 수 있다. AP2 검증은 merchant가 하고, facilitator는 표준 x402 field만 본다.

## 빠른 시작

```bash
git clone --recursive https://github.com/LOBYI/x402-AP2.git   # forge-std submodule 포함
cd x402-AP2 && npm install
npm test        # 39개 test (자세한 내용은 아래 test guide)
```

이미 클론했다면 `git submodule update --init`으로 forge-std를 받는다.

**Merchant**: handler를 감싸기만 하면 된다. Web 표준 `Request → Response` 방식이고, Node/Express용 adapter도 있다.

```ts
const merchant = new Ap2X402Merchant({
  merchant: { id: "weather.example", name: "Weather Co.", website: "https://weather.example" },
  signingKey,                                   // checkout 서명 key (JWK)
  payTo: "0x…", asset: USDC_BASE,
  facilitator: new OnchainFacilitator({ walletClient, publicClient }),   // 또는 HttpFacilitator
  resolveUserKey: (iss) => users.get(iss) ?? null,   // AP2 신뢰 anchor
});

const handler = merchant.protect(                // (req: Request) => Promise<Response>
  (req, payment) => Response.json({ forecast: "sunny" }),
  { cart: () => ({ line_items: [{ id: "forecast-7d", title: "7-day forecast", quantity: 1, unit_price: 25 }] }) },
);
// Hono·Bun·Workers: { fetch: handler }   Node·Express: toNodeHandler(handler, { baseUrl })
```

**사용자 → agent 위임**: AP2 open mandate를 발급한다.

```ts
const openCheckoutMandate = await createOpenCheckoutMandate(user.privateJwk, [
  { type: "checkout.allowed_merchants", allowed: [merchant] },
  { type: "checkout.line_items", items: [{ id: "w", acceptable_items: [{ id: "forecast-7d", title: "7-day forecast" }], quantity: 1 }] },
], { issuer: "user:alice", agentPublicJwk: agent.publicJwk });

const openPaymentMandate = await createOpenPaymentMandate(user.privateJwk, [
  { type: "payment.amount_range", currency: "USD", max: 100 },   // 건당 $1
  { type: "payment.budget", currency: "USD", max: 500 },         // 누적 $5
], { issuer: "user:alice", agentPublicJwk: agent.publicJwk });
```

**Agent**: `fetch`를 그대로 대체한다. 402가 오면 제약을 확인하고 결제한 뒤 다시 요청한다.

```ts
const client = new Ap2X402Client({
  wallet,        // EIP-712 서명자: viem Account, 또는 MetaMask 같은 원격 서명자 (PaymentSigner)
  mode: { kind: "human_not_present", agentKey: agent.privateJwk, userPublicKey: user.publicJwk,
          openCheckoutMandate, openPaymentMandate },
  // 매번 사용자가 승인하는 방식: { kind: "human_present", userId, userKey, confirm: (checkout) => … }
});

const res = await client.fetch("https://weather.example/forecast");
```

## Extension spec: `extensions.ap2`

x402 v2 message 중 **AP2가 추가하는 부분만** 보여준다.

```jsonc
// 402 · PAYMENT-REQUIRED
"extensions": { "ap2": { "info": {
  "version": "0.2",
  "merchant": { "id", "name", "website" },
  "checkoutJwt": "eyJ…",        // merchant ES256 서명: line_items · total(USD cent) · nonce · resource · payment_requirements
  "merchantJwk": { … },
  "modes": ["human_present", "human_not_present"]
} } }

// 재요청 · PAYMENT-SIGNATURE  (402의 info를 그대로 되돌려주고 아래 두 field를 추가)
"extensions": { "ap2": { "info": { …,
  "checkoutMandate": "<user open mandate>~~<agent hop: mandate.checkout.1>~",
  "paymentMandate":  "<user open mandate>~~<agent hop: mandate.payment.1>~"
} } }
```

| AP2 (`mandate.payment.1`) | ⇄ | x402 |
| --- | --- | --- |
| `payment_amount` (USD cent) | ×10⁴ | `accepted.amount` (USDC atomic) |
| `payee` | checkout 서명 | `payTo` |
| `payment_instrument.id` (CAIP-10) | = | `authorization.from` |
| `keccak256(paymentMandate)` | = | `authorization.nonce` |

mandate 형식은 AP2 SD-JWT를 따르고, 위임 단계(hop) 사이는 `~~`로 잇는다.
- **human-not-present**: 사용자 open mandate 뒤에 agent hop을 붙인다. hop은 `cnf.jwk` key로 서명하고, `sd_hash`로 앞 token과 연결한다.
- **human-present**: 사용자가 closed mandate에 직접 서명한다.
- 두 방식 모두 `aud = merchant.id`, `nonce = checkout.nonce`를 넣는다.

## Merchant 검증 순서

1. **[AP2]** `checkoutJwt`가 자기 서명이고 만료 전이며, 요청 URL과 같은지
2. **[x402]** `accepted`가 checkout에 서명해 둔 requirement와 같은지 (client가 보낸 값은 믿지 않음)
3. **[AP2]** mandate chain: 사용자 root 서명, hop 서명, `sd_hash`, `aud`, `nonce`, 만료, 두 chain의 발급자가 같은지
4. **[AP2]** cart·금액·수취인·결제수단이 일치하는지, open mandate 제약을 지키는지
5. **[binding]** `authorization.nonce == keccak256(paymentMandate)`
6. **[x402]** facilitator `/verify` → 재사용 차단(`ReplayStore`) → handler 실행 → **handler가 성공(< 400)했을 때만** `/settle`.
   handler가 실패하면 청구하지 않고, 정산이 실패하면 content를 내주지 않는다. 정산 결과는 `PAYMENT-RESPONSE` header로 전달한다.

## Test guide

아래로 갈수록 실제 환경에 가까워진다. 4단계만 실제 testnet 자산을 쓴다.

| 단계 | 명령 | 필요한 것 | 비용 | 확인하는 것 |
| --- | --- | --- | --- | --- |
| 1. 자동 test | `npm test` | Node ≥ 20 (anvil 있으면 on-chain test 포함) | 없음 | SDK logic, 공격 차단, on-chain 정산 |
| 2. contract 교차검증 | `npm run forge:test` | Foundry | 없음 | SDK 서명이 Solidity에서 그대로 통과하는지 |
| 3. local demo | `npm run demo:*` | 없음 | 없음 (가짜 정산) | 실제 HTTP로 붙는지, UI 동작 |
| 4. Sepolia live test | `npm run testnet:*` | Sepolia ETH, Circle test USDC | testnet 자산 | 실제 USDC contract에서 정산, MetaMask 서명 |

### 1. 자동 test - `npm test`

| File | 개수 | 내용 |
| --- | --- | --- |
| `test/e2e.test.ts` | 19 | 두 mode 결제 흐름, 예산·횟수·금액·품목 제약, merchant 측 공격 차단(제약 우회, nonce 위조, 금액·수취인 변조, 재사용, resource 바꿔치기, 위임받지 않은 agent, payTo 변조) |
| `test/unit.test.ts` | 10 | SD-JWT 발급·위임·chain 검증, 제약 평가, USD⇄USDC 변환, EIP-3009 서명 |
| `test/protect.test.ts` | 4 | handler 실패 시 미청구, 정산 실패 시 content 미제공, 정산 대기 중 GC가 돌아도 요청 본문 유지(회귀) |
| `test/http.test.ts` | 1 | facilitator HTTP API 왕복, merchant event |
| `test/anvil.test.ts` | 5 | anvil을 띄워 실제 정산: USDC 이동, payer gas 0, event nonce = mandate hash, 재사용·잔액 부족·동시 정산·다른 chain 차단 (anvil이 없으면 건너뜀) |

### 2. Contract 교차검증 - `npm run forge:test`

`contracts/`는 Foundry project다. `MockUSDC.sol`은 Sepolia·Base Sepolia USDC와 같은 서명 규격(`"USDC"`, `"2"`)을 가진 EIP-3009 token이다.

- `MockUSDC.t.sol` (15개): 정상 이체, 재사용, 만료, 서명 위조, high-s, 다른 chain 재사용, 취소, 잔액 부족, fuzz 512회
- `SdkVector.t.sol` (6개): TS SDK가 AP2 흐름 전체로 만든 서명(`scripts/gen-forge-vector.ts`)이 Solidity에서 정산되는지, `keccak256(paymentMandate) == nonce`가 on-chain에서 재현되는지

### 3. Local demo - 돈 없이 실제 HTTP로

`LocalFacilitator`가 서명만 검사하고 정산은 흉내만 낸다.

```bash
npm run demo:server    # terminal 1: merchant :4020 + facilitator :4021
npm run demo:web       # terminal 2: browser 지갑 → http://127.0.0.1:4040
```

다른 client도 같은 server에 붙을 수 있다.

| 명령 | 내용 |
| --- | --- |
| `npm run demo:client` | agent 자동 결제 3회 (3번째는 예산 초과로 거부). `--mode hp`, `--path /api/translate --text "…"`, `--verbose` |
| `npm run demo:shop` | terminal 대화형 상점 (human-present) |
| `npm run demo:attack` | 변조·재사용 공격 10종을 보내 모두 402로 거부되는지 확인 |
| `curl -si http://127.0.0.1:4020/api/forecast` | SDK 없이 402 원문 보기 (`PAYMENT-REQUIRED` header는 base64 JSON) |

local chain(anvil)에서 실제로 token을 옮기고 싶다면:

```bash
anvil                                                         # terminal 1
(cd contracts && forge build) && npm run demo:anvil-setup     # MockUSDC 배포, payer에 100 USDC
RPC_URL=http://127.0.0.1:8545 USDC_ADDRESS=0x… npm run demo:server   # 출력된 값 사용
PAYER_KEY=0x… npm run demo:client
```

### 4. Sepolia live test - Circle USDC로 실제 정산

**준비 (한 번만)**

1. `npm run testnet:wallet` - payer 지갑을 만들어 `.env`에 저장한다(주소만 출력).
2. [faucet.circle.com](https://faucet.circle.com)에서 "Ethereum Sepolia"를 고르고, payer 주소로 USDC를 받는다.
3. `.env`에 `FACILITATOR_PRIVATE_KEY`를 넣는다. Sepolia ETH가 있는 지갑이며, 정산 gas를 낸다.
4. (선택) `PAY_TO`에 merchant 수취 주소를 넣는다. 비워두면 facilitator 주소로 받는다.
5. `npm run testnet:check` - key, 잔액, token 서명 규격을 점검한다. 모두 ✔이면 준비 완료다.

| `.env` 변수 | 용도 |
| --- | --- |
| `RPC_URL` | Sepolia RPC (기본 publicnode). Base Sepolia는 `https://sepolia.base.org` |
| `FACILITATOR_PRIVATE_KEY` | 정산 transaction을 보내고 gas를 내는 지갑 |
| `PAYER_KEY` | server key로 결제할 때의 payer. USDC만 있으면 되고 ETH는 필요 없음 |
| `PAY_TO` | merchant 수취 주소 (기본: facilitator 주소) |
| `USDC_ADDRESS` | token 주소 (기본: chain별 Circle USDC) |

`.env`는 git에서 제외된다. key를 commit하거나 chat·issue에 붙여넣지 말아야 한다.

**실행**

```bash
npm run testnet:server   # terminal 1 - 정산될 때마다 Etherscan link가 log에 찍힘
```

terminal 2에서 원하는 방식을 고른다.

| 명령 | 방식 |
| --- | --- |
| `npm run testnet:web` | **browser 지갑** http://127.0.0.1:4040 - 승인 button, 1–10단계 timeline, mode 전환, MetaMask |
| `npm run testnet:shop` | terminal 대화형 상점 (상품 선택 → 승인/거절) |
| `npm run testnet:client` | agent 자동 결제 (human-not-present) |
| `npm run testnet:attack` | 실제 USDC contract 상대로 공격 10종 (정상 결제 1건만 정산) |

**Browser 지갑 사용법**

1. 왼쪽 위 **결제 지갑**에서 서명자를 고른다.
   - **server key**: `.env`의 `PAYER_KEY`가 송금 서명을 한다.
   - **🦊 MetaMask**: 연결하면 Sepolia로 자동 전환한다. 송금 서명(EIP-3009)은 MetaMask가 `eth_signTypedData_v4`로 직접 하고, AP2 mandate는 지갑 app의 사용자 key가 서명한다(MetaMask는 ES256 JWS를 서명할 수 없음). MetaMask 계정에는 USDC만 있으면 되고 ETH는 필요 없다.
2. **AP2 mode**를 고른다.
   - **직접 승인**(human-present): 402가 오면 checkout card에서 승인/거절한다. MetaMask를 쓰면 app 승인(AP2) → MetaMask 서명(x402) 순서로 두 번 승인한다.
   - **agent 위임**(human-not-present): 건당 한도·누적 예산·허용 상품을 정해 open mandate를 발급하면, agent가 그 안에서 승인 없이 결제한다.
3. 상품을 고르고 오른쪽 timeline에서 단계별 진행과 Etherscan link를 확인한다.

key는 지갑 app(Node)에만 있고 browser로는 넘어가지 않는다. 지갑 API는 `127.0.0.1`에서만 열리고, 실행할 때마다 새로 만드는 token과 Origin 검사로 다른 site의 호출을 막는다.

### Scenario checklist

| scenario | 방법 | 기대 결과 |
| --- | --- | --- |
| 정상 결제 | 직접 승인 → 날씨($0.25) 승인 | 200 응답, Etherscan에서 tx 확인, 잔액 변화 |
| 거절 | 직접 승인 → 거절 (또는 MetaMask에서 Reject) | 서명·송금 없음, 잔액 그대로 |
| 본문 기반 가격 | 번역에 문장 입력 | 단어당 $0.01로 가격 결정, 응답 정상 |
| 건당 한도 | agent 위임(건당 $1) → report($5) | agent가 결제 전에 거부, tx 없음 |
| 누적 예산 | agent 위임(예산 $0.60) → 날씨 3회 | 2회 정산, 3번째 거부 |
| 잔액 부족 | 직접 승인 → report($5)를 잔액 $5 미만 지갑으로 승인 | facilitator가 `insufficient_funds`로 거부, tx 없음 |
| 공격 | `npm run testnet:attack` | 10/10 통과 |

### 결과 확인

- **Etherscan**: server log, browser timeline, 기록 목록의 tx link
- **cast**: `cast call <USDC> "balanceOf(address)(uint256)" <주소> --rpc-url $RPC_URL`
- **merchant event log**: `curl http://127.0.0.1:4020/dev/events` (402 발행 / 정산 / 거부와 사유)
- 정산 event `AuthorizationUsed`의 nonce가 `keccak256(paymentMandate)`와 같은지 보면, AP2와 x402가 chain 위에서 묶였는지 확인할 수 있다.

### 문제 해결

| 증상 | 원인과 해결 |
| --- | --- |
| `merchant_untrusted` | client가 접속한 주소와 server `PUBLIC_URL`의 origin이 다름. `localhost`와 `127.0.0.1`을 섞으면 안 된다 |
| `insufficient_funds` | payer(또는 MetaMask 계정)에 USDC 부족. `testnet:check`로 확인 |
| MetaMask 창이 안 뜸 | browser에 MetaMask가 없거나 다른 계정이 선택됨. 지갑 app의 MetaMask 주소와 같은 계정을 선택해야 한다 |
| 결제 직후 잔액이 그대로 | 공개 RPC가 새 block을 늦게 반영. 몇 초 뒤 `↻ 잔액` |
| proxy 뒤에서 431/400 | `PAYMENT-SIGNATURE` header가 7–10KB. nginx 등의 header 한도를 늘려야 한다 |
| server 시작 실패 (`EADDRINUSE`) | 이미 떠 있는 server가 있음. `pkill -f demo/server.ts; pkill -f demo/web/server.ts` |

## 운영 시 주의

- `LocalFacilitator`는 test 전용이다(실제 송금 없음). 운영에서는 `OnchainFacilitator`나 `HttpFacilitator`를 써야 한다.
- `OnchainFacilitator`는 gas 지갑 하나로 transaction을 보낸다. 동시 정산이 많으면 transaction nonce가 꼬일 수 있으니 queueing을 붙여야 한다.
- 누적 예산(`payment.budget`)과 사용 횟수(`agent_recurrence`)는 지출 원장(`SpendLedger`)을 가진 agent만 강제할 수 있다.
- `ReplayStore`와 `SpendLedger`는 기본이 in-memory다. 여러 instance로 운영하면 Redis나 DB로 구현해야 한다.
- client는 merchant `website`의 origin이 요청 URL과 같을 때만 그 merchant key를 믿는다. 미리 알고 있는 key가 있으면 `resolveMerchantKey`로 고정하는 것이 좋다.
- 지원 범위: `exact` scheme + EIP-3009 token, mandate chain 깊이 1–2, SD-JWT 선택적 공개는 최상위 claim만.

## 구조

```
src/x402/      x402 base    types · headers · evm(EIP-3009) · facilitator(Local/Http/Onchain/handler)
src/ap2/       AP2          types · sdjwt · mandates · constraints
src/bridge/    extension    extensions.ap2 · nonce binding · USD⇄USDC · 통합 검증
src/client/    Ap2X402Client · SpendLedger
src/server/    Ap2X402Merchant · ReplayStore · toNodeHandler
demo/          server(merchant+facilitator) · client · shop · attack · anvil-setup · web/(browser 지갑)
contracts/     Foundry: MockUSDC(EIP-3009) · forge test · SDK 교차검증 vector
scripts/       testnet-wallet · testnet-check · gen-forge-vector
test/          vitest (e2e · unit · protect · http · anvil)
```

참고 spec: [x402 v2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) · [AP2 SDK/schema](https://github.com/google-agentic-commerce/AP2/tree/main/code/sdk) · nonce binding은 AP2 공식 x402 PSP 예제 방식을 따른다.
