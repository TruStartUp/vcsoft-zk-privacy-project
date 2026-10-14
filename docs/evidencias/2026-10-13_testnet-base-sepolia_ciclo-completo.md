# Ciclo completo en Base Sepolia: 13/10/2026

Red de pruebas **Base Sepolia** (`chainId` 84532). Explorador: <https://sepolia.basescan.org>.

Este documento recorre el ciclo de punta a punta sobre los contratos desplegados (ver
[`2026-10-13_testnet-base-sepolia_despliegue.md`](2026-10-13_testnet-base-sepolia_despliegue.md)).
Intervienen `zk-api` corriendo contra la cadena real, el cliente de referencia del titular
(`zk-holder`) y la plataforma (Y), que presenta las pruebas y paga el gas. Cada paso remite a su
transacción en Basescan, y el log crudo es
[`2026-10-13_e2e_base-sepolia_ciclo-completo.log`](2026-10-13_e2e_base-sepolia_ciclo-completo.log).

## Estado

| | |
|---|---|
| Resultado | **Ciclo completo.** Los doce pasos y el cierre, en verde |
| Corridas | Cuatro sobre el mismo estado (`id 4a4df531`), todas en el log. La 1.ª y la 2.ª se detuvieron por una comprobación del propio orquestador y por una lectura de eventos que agotó los reintentos (ver [Incidencias](#incidencias-de-la-corrida)). Ninguna transacción se envió dos veces. La 4.ª no hizo nada: lo demuestra |
| Transacciones | 25 confirmadas: 23 firmadas por Y y 2 por A. 24 con éxito y 1 revertida a propósito |
| Gasto | Y 0,000036032 ETH (límite 0,005) · X 0 (límite 0,002) · A 0,0000028 ETH de gas propio · B y C, 0 |
| Commit base | `f1c8f37` más el árbol de trabajo: `zk-holder/` nuevo y el cambio de `zk-api` descrito en [Cambios en `zk-api`](#cambios-en-zk-api) |

## Entorno

| Pieza | Configuración |
|---|---|
| `zk-api` | `npm run start:testnet`, que lee `zk-api/.env.testnet` (ignorado por git) en lugar de `.env`, en el puerto 3060. `ISSUER_PRIVATE_KEY` = Y. Registro `0xA3fc…B8AA`, atestador `0x83C0…9D09`, `REGISTRY_DEPLOYMENT_BLOCK` 48076954, `CHAIN_CONFIRMATIONS` 2. Secretos nuevos con `npm run keys:generate` |
| Almacenes | Los contenedores de siempre, `zk-api-postgres` y `zk-api-redis`, con base propia **`zkapi_testnet`** y Redis lógico **1**, así la suite (`zkapi_test`, Redis 0) no la trunca. Migraciones con `npm run prisma:migrate:testnet` |
| Titular | `zk-holder`: secreto, copia cifrada, firma de posesión, testigo y prueba Groth16 en local con `zk-circuits/build/compliance_js/compliance.wasm` y `groth16.zkey` (las claves no se regeneraron) |
| Orquestador | `zk-holder/e2e/base-sepolia.ts` (`npm run e2e:base-sepolia`). Guarda su estado (claves de las billeteras de prueba, secretos de socio, copias de seguridad, transacciones) en `zk-holder/e2e/state/base-sepolia.json`, ignorado por git, y se retoma sin reenviar lo que ya está en cadena |
| RPC | Endpoint de Base Sepolia en `CHAIN_RPC_URL`; consultas de eventos en ventanas de `CHAIN_LOG_BLOCK_RANGE` bloques (ver [Hallazgos](#hallazgos)) |

## Billeteras y cuentas

| | Dirección | Papel |
|---|---|---|
| X | [`0xb447…A5C2`](https://sepolia.basescan.org/address/0xb44703b4D47Fd595f6383909aCF424cA6612A5C2) | Despliegue. **No firmó nada** en esta corrida |
| Y | [`0xbddD…4337`](https://sepolia.basescan.org/address/0xbddD8970657eb2B08f6E6bc78abB3f5c2B8d4337) | Plataforma: emisor en `zk-api`, agente del activo, dueña de la `IdFactory`, firmante de claims, presentadora de las pruebas |
| A | [`0xCD72…4C96`](https://sepolia.basescan.org/address/0xCD724691C8de3C3962925BFEa34d95d1A8F64C96) | Inversor, EOA nueva, Colombia (170). ONCHAINID [`0x0e41…fdEE`](https://sepolia.basescan.org/address/0x0e41F772cd5E705AA3cf005e444990eB4728fdEE) |
| B | [`0x1eCC…57A0`](https://sepolia.basescan.org/address/0x1eCC66B9C3Fa2BcCAB22dDc02850E9eB3EDf57A0) | Inversor, EOA nueva, México (484). ONCHAINID [`0xC49a…2799`](https://sepolia.basescan.org/address/0xC49a11180B0A8E79EDb44F09Ec8dc32963c82799) |
| C | [`0x546f…fA15`](https://sepolia.basescan.org/address/0x546fed1362A9fc69aE4666a3375859AeeAebfA15) | Inversor, EOA nueva, Estados Unidos (840), país que el activo no admite. ONCHAINID [`0xbCe7…153C`](https://sepolia.basescan.org/address/0xbCe7231F0CE0497275115F45b6C489A79288153C) |

Los datos de identidad de A, B y C son ficticios y lo dicen ellos mismos: «PRUEBA E2E - Inversor A
(persona ficticia)», documento `E2E-TEST-A-0001`, etc.

## Socios de la API

Creados por el operador con `npm run partner:create` (el secreto se imprime una vez; el
orquestador lo guarda en su estado y el log lo tapa).

| Socio | Clave | Alcances |
|---|---|---|
| Plataforma | `pk_9863…e1f3` | `credentials:issue` `credentials:activate` `credentials:revoke` `credentials:read` `credentials:opening` `jurisdictions:write` |
| Banco | `pk_5d02…dc79` | `proofs:verify` `proofs:read` `compliance:read` `disclosures:request` `disclosures:read` **`disclosures:approve`** |
| Cumplimiento | `pk_2ec5…6ade` | `disclosures:approve` `disclosures:read` |
| Auditoría | `pk_a1e7…32aa` | `audit:read` |
| Operador | `pk_d357…62f7` | `issuer:admin` |

**El banco lleva también `disclosures:approve`, a propósito.** Sin ese alcance su intento de
aprobarse a sí mismo se quedaría en `insufficient_scope`, porque el alcance se comprueba antes que
la solicitud, y nunca llegaría a la regla que se quiere demostrar. Con él se ve que la separación
de partes la impone el código por solicitud (`disclosure_self_decision`) y no depende de repartir
bien los alcances. El rechazo por alcance también aparece en la corrida: el banco pide la
integridad del registro de accesos y recibe `insufficient_scope`.

## Paso a paso

### 0 · Comprobaciones previas (solo lectura)

Red 84532, la clave cargada es Y, `zk-api` responde. En cadena: Y tiene `ISSUER_ROLE` y
`JURISDICTION_ROLE` en el registro y `ATTESTATION_MANAGER_ROLE` en el atestador. Además es agente
del IR y del token, dueña de la `IdFactory` y clave de tipo CLAIM del `ClaimIssuer`, y el único
módulo de la `ModularCompliance` es el ZK. Se anotan los saldos de partida para el control de gasto.

### 1 · Socios con alcances separados

Cinco socios, cada uno con lo suyo (tabla de arriba). Ninguno tiene a la vez emisión y auditoría,
ni el operador lee aperturas.

### 2 · Inversores A y B en el estándar ERC-3643

Para cada uno, firmado y pagado por Y con la `IdFactory` compartida, como se usa normalmente:
`createIdentityWithManagementKeys` (Y como clave de gestión), `addKey` del `ClaimIssuer` con
propósito CLAIM y `addClaim` del tópico 1. El claim lo firma Y con EIP-191 sobre
`keccak256(abi.encode(identidad, 1, "kyc-approved"))`. Después, `registerIdentity` en el IR del
activo ZK. **Demuestra** que los dos quedan `isVerified = true` en el estándar. Transacciones 1 a 8.
No se cambió la configuración de ningún contrato compartido.

### 3 · Jurisdicciones admitidas

`PUT /v1/assets/84532001/jurisdictions` con `[170, 484, 604, 152, 724]` (Colombia, México, Perú,
Chile, España). `zk-api` publica la raíz con Y
([tx 9](https://sepolia.basescan.org/tx/0x6ceceaa18656faac676a133076547ab1f2ff59c315e12e591cf2761c21d767ea)),
y `countryRootOf(84532001)` en cadena coincide con la que devuelve la API.

### 4 · Emisión en dos tiempos

Por inversor: `POST /v1/credentials` (plataforma) con el veredicto KYC aprobado, caducidad a
**120 días** (10/02/2027) y la identidad ficticia, que queda sellada. Respuesta `PENDING`. Después,
en el lado del titular y sin red:

1. secreto por muestreo uniforme en el campo;
2. copia de seguridad scrypt + AES-256-GCM bajo una frase, que se vuelve a abrir antes de seguir;
3. `secretHash = Poseidon(secreto)`;
4. compromiso esperado `Poseidon(secretHash, país, caducidad)`, calculado por el titular;
5. firma de posesión EIP-712 `CredentialActivation` con el dominio reimplementado en el cliente. Se
   comprueba que es el mismo que entrega la API, y la firma se recupera a la billetera del titular.

`POST /v1/credentials/:id/activation` con `secretHash` y la firma. **Demuestra** que el compromiso
que publica el emisor coincide con el que calculó el titular (A, hoja 0; B, hoja 1), sin que el
emisor vea nunca el secreto. Ni A ni B envían una transacción: la publicación de la raíz la paga Y
a través de `zk-api` (tx 10 y 11).

### 5 · Prueba local y comprobación previa del banco

Para cada titular: las dos aperturas (`credentials:opening`), y de la cadena, en un mismo bloque,
`currentEpochEnd` (1793664000), `epochLength` (2592000) y `anchorFor(titular)`. El periodo reclamado
es `currentEpochEnd + epochLength` = 1796256000 (03/12/2026). El cliente comprueba cada raíz antes
de probar.

La prueba Groth16 sale en local en unos 1,0 s y 0,8 s y verifica contra `groth16.vkey.json`.
`POST /v1/verifications` (banco) responde `valid: true` para las dos, con las seis señales en el
orden del circuito.

### 6 · Y presenta con `attestFor` y paga el gas

| | A | B |
|---|---|---|
| Antes: nonce · saldo | 0 · 0 ETH | 0 · 0 ETH |
| Transacción | [tx 12 `0xcee4…9860`](https://sepolia.basescan.org/tx/0xcee4d8adf46e97a74e4c4028eb88a6ff75d59b1a99bf87d89be2d227b62b9860), 345 229 gas | [tx 13 `0x3bec…37f0`](https://sepolia.basescan.org/tx/0x3becdb531aa7784db689368f906874eca5253e9f2e493054189b201ad4c037f0), 345 229 gas |
| Remitente | Y | Y |
| `ComplianceAttested.subject` | A | B |
| Después: nonce · saldo | 0 · 0 ETH | 0 · 0 ETH |

**Demuestra** lo que prometió el acta 1: el inversor no envía ninguna transacción ni paga gas para
atestiguar. El nonce y el saldo de A y B siguen en cero después de que la atestación queda escrita
a su nombre. El anclaje de cada prueba es `anchorFor(titular)`, así que la presenta Y pero
atestigua al titular.

La guía para quien presenta se ejerció de verdad. La 1.ª corrida se detuvo justo después de minar
`attestFor(A)` (ver [Incidencias](#incidencias-de-la-corrida)). Al retomar, la simulación de la
misma prueba revirtió con `NullifierAlreadySpent`, `attestationOf(84532001, A)` ya mostraba ese
nulificador, y el presentador lo dio por éxito sin enviar nada: `already_attested`.

### 7 · Estado de cumplimiento

`GET /v1/compliance/assets/84532001/subjects/{A|B}` (banco): `compliant: true`, con emisión,
caducidad (03/12/2026) y nulificador. La respuesta no contiene datos personales.

### 8 · Acuñación y transferencia

- Y, como agente, `mint(A, 1000 ZKCTA)` ([tx 14](https://sepolia.basescan.org/tx/0x8374d95335ec5199dd63087ed1a31a81edd645c838f0fb51ed5a80c284ff7869)).
  Pasa porque `moduleCheck` encuentra la atestación de A.
- Fondeo mínimo de A desde Y para sus dos transferencias: 0,000009845032 ETH
  ([tx 15](https://sepolia.basescan.org/tx/0x679ab99aef0624f5c541d1976e1f0cd71522db5b355f68b1c07fa5aa3136994a)).
  Es el gas estimado × 1,3 × el doble de la tarifa máxima, más un margen para la tarifa L1, para
  dos transacciones. Es la única ETH que reciben los inversores, y se envía **después** de las
  atestaciones.
- A transfiere 250 ZKCTA a B ([tx 16](https://sepolia.basescan.org/tx/0x652e8f9f7c968f12c7d3e75d15b09295deffe18faa01cea0d89a5b39e8c4a983)),
  firmada y pagada por A. Saldos: A 750, B 250.

### 9 · Revocación de B

1. `POST /v1/credentials/{B}/revocation` con `closeRootWindow: true` (plataforma). `zk-api` publica
   la raíz sin la hoja de B ([tx 17](https://sepolia.basescan.org/tx/0xaa9f2c42324665a09824321cbd2935dc7844a8329b5316d7a3b7e262dd3364f6))
   e invalida la anterior ([tx 18](https://sepolia.basescan.org/tx/0x784c1d5e1e0b6887bc98744fb00f21a8f814c80c3146f635a984415856cb0fc8)).
   `isCredentialRootValid(raíz anterior)` = `false`.
2. Y corta la atestación viva con `revokeAttestation(84532001, B)`
   ([tx 19](https://sepolia.basescan.org/tx/0xe3549ccbb30a3ba6c5bb32c46f58617a9bb3b2e22b59c463a74c9376845e5b3b)).
   Revocar la credencial no corta por sí solo una atestación ya concedida, así que hacen falta las
   dos cosas.

**Demuestra:**

- `GET /v1/credentials/{B}`: `REVOKED`, `inRegistry: false`.
- `GET /v1/compliance/.../B`: `compliant: false`. A sigue `compliant: true`.
- Una transferencia de A a B se rechaza, y el rechazo es del módulo ZK. Antes de intentarla se
  comprueba que ninguna otra regla del estándar bloquearía: `IR.isVerified(B)` y `(A)` son `true`,
  el token no está en pausa, nadie está congelado, A no tiene saldo congelado y le alcanza el saldo.
  Además, el único módulo es el ZK y `moduleCheck(A, B)` = `false` → `canTransfer(A, B)` = `false`.
  La transferencia, enviada de verdad, **revierte en cadena**
  ([tx 20](https://sepolia.basescan.org/tx/0xa59b8ff33ea41ba500a90c579fd4da80378073681b03b45058eb00cfb95ad2b6),
  estado fallido, la paga A), y la simulación da el motivo `"Transfer not possible"` (paso de
  cierre). Saldos sin cambios.
- `GET /v1/verifications/:id` de las dos verificaciones previas: `valid: true`,
  `nullifierSpent: true`, `standing: "superseded_root"`, `credentialRootStillValid: false`. No
  contienen datos personales: ni nombre, ni documento, ni dirección del titular.

### 10 · Divulgación autorizada con separación de partes

Sobre la credencial revocada de B, con alcance `identity.legalName` e `identity.countryCode`:

| # | Quién | Llamada | Respuesta |
|---|---|---|---|
| 1 | Banco | `POST /v1/disclosures` | 201 `PENDING` |
| 2 | Banco | `POST /:id/decision` `APPROVED` | **403 `disclosure_self_decision`** |
| 3 | Cumplimiento | `POST /:id/decision` `APPROVED` | 200 `APPROVED`, `decidedByPartnerKey` = cumplimiento, `decidedByActor` = `e2e:oficial-cumplimiento` |
| 4 | Cumplimiento | `POST /:id/release` | **403 `disclosure_not_requester`** |
| 5 | Banco | `POST /:id/release` | 200: `{legalName: "PRUEBA E2E - Inversor B (persona ficticia)", countryCode: 484}` y nada más |
| 6 | Banco | `POST /:id/release` otra vez | 403 `disclosure_not_approved` (ya `RELEASED`) |

**Demuestra** que solo se liberan los atributos aprobados. El número de documento, la fecha de
nacimiento y la dirección siguen sellados.

### 11 · Reconstrucción desde la cadena e integridad del registro

- `POST /v1/issuer/state/rebuild` (operador): 3 eventos, 1 hoja (A), `matchesChain: true`, sin
  diferencias en ningún sentido.
- `POST /v1/issuer/assets/84532001/state/rebuild`: 5 eventos, 5 hojas, `matchesChain: true`.
- `GET /v1/access-log/integrity` (auditoría): `intact: true`, 30 de 30 entradas.
- El banco pide la integridad: 403 `insufficient_scope`.

### 12 · C, con un país no admitido, no obtiene una prueba válida

C se prepara igual que A y B: ONCHAINID, claim, IR con país 840 (tx 21 a 24) y credencial activa
con país 840 (tx 25). El estándar lo da por verificado. Después:

| Intento | Qué hace | Resultado |
|---|---|---|
| Pedir su apertura | `GET /v1/assets/84532001/jurisdictions/840/opening` | 404 `jurisdiction_not_admitted`: no existe una apertura para 840 |
| 1 | País real 840 con la única apertura disponible (la de 170) | El cliente lo rechaza antes de probar: `jurisdiction_mismatch` |
| 2 | Lo mismo, saltándose las comprobaciones del cliente | El circuito no tiene testigo: `Assert Failed … line: 109`, que es `inAllowed.root === countryRoot`. La hoja 840 no está en el árbol del activo |
| 3 | Declarar 170 en lugar de 840 | `Assert Failed … line: 94`, que es `inRegistry.root === credentialRoot`. El compromiso publicado fija 840, así que con 170 no hay credencial |

En cadena, `IR.isVerified(C)` = `true` y aun así `canTransfer(0, C)` = `false`. La simulación de
`mint(C)` por Y revierte con `"Compliance not followed"`, y la de `transfer(A → C)` con
`"Transfer not possible"`. Ninguna se envió. `GET /v1/compliance/.../C`: `compliant: false`.

### Cierre

Simulaciones para leer el motivo de cada rechazo (la primera vez el orquestador solo imprimió
`"Error"`; ver [Incidencias](#incidencias-de-la-corrida)), y reconstrucción final con C dentro:

- credenciales: 4 eventos, 2 hojas (A y C), `matchesChain: true`;
- activo: 5 hojas, `matchesChain: true`;
- registro de accesos íntegro, 44 de 44 entradas.

## Transacciones

Coste = gas L2 × precio efectivo (0,006 gwei en todas) + tarifa L1, según el recibo.

| # | Paso | Hash | Firma | Vía | Bloque | Gas | Éxito | Coste (ETH) |
|---|---|---|---|---|---|---|---|---|
| 1 | Identidad A · `createIdentityWithManagementKeys` | [`0xc1d94697…d78d7d`](https://sepolia.basescan.org/tx/0xc1d94697e228f994b428631849f8ffea735dcc7acc474cefa10e9af898d78d7d) | Y | orquestador | 48078561 | 451 825 | sí | 0,000002710950 |
| 2 | Identidad A · `addKey(ClaimIssuer, CLAIM)` | [`0x25e1205c…f16e1e`](https://sepolia.basescan.org/tx/0x25e1205cd20db2a141ee6c625673dd5e99201f9bca89154d5f1cbbfc1ff16e1e) | Y | orquestador | 48078564 | 179 071 | sí | 0,000001074426 |
| 3 | Identidad A · `addClaim` (tópico 1, firmado por Y) | [`0x8cc51729…7588ea`](https://sepolia.basescan.org/tx/0x8cc51729f4c470496520f41f3022040bcb1b0248b6aee645a08804da027588ea) | Y | orquestador | 48078567 | 299 779 | sí | 0,000001798674 |
| 4 | IR · `registerIdentity(A, 170)` | [`0x02b686ca…5c22af`](https://sepolia.basescan.org/tx/0x02b686cad524eec71816a262d04774107a1600fda736a3af854b1d537f5c22af) | Y | orquestador | 48078570 | 79 566 | sí | 0,000000477396 |
| 5 | Identidad B · `createIdentityWithManagementKeys` | [`0xda5a170d…552a71`](https://sepolia.basescan.org/tx/0xda5a170d9d5aa0bd34486293c526c3c79a71cdd189476928ba8289ba2e552a71) | Y | orquestador | 48078573 | 451 825 | sí | 0,000002710950 |
| 6 | Identidad B · `addKey(ClaimIssuer, CLAIM)` | [`0xf5c2ed16…6f39a6`](https://sepolia.basescan.org/tx/0xf5c2ed16654c3596c674d66651be7d084495e3a5f06c99b668b0a173e66f39a6) | Y | orquestador | 48078576 | 179 071 | sí | 0,000001074426 |
| 7 | Identidad B · `addClaim` (tópico 1, firmado por Y) | [`0x0284fd19…38c6ef`](https://sepolia.basescan.org/tx/0x0284fd19982d81666088651ac1445297b1a33f9ce039a23ac637fd7dd338c6ef) | Y | orquestador | 48078579 | 299 779 | sí | 0,000001798674 |
| 8 | IR · `registerIdentity(B, 484)` | [`0x56777fda…73d48d`](https://sepolia.basescan.org/tx/0x56777fdae228a080f3ec347203498f6b0e6ea3d1f30116ce669cb2cb7473d48d) | Y | orquestador | 48078582 | 79 590 | sí | 0,000000477540 |
| 9 | Registro · `publishCountryRoot` (conjunto admitido) | [`0x6ceceaa1…d767ea`](https://sepolia.basescan.org/tx/0x6ceceaa18656faac676a133076547ab1f2ff59c315e12e591cf2761c21d767ea) | Y | `zk-api` | 48078585 | 69 478 | sí | 0,000000416868 |
| 10 | Registro · `publishCredentialRoot` (activación A) | [`0x65b826b0…9475a0`](https://sepolia.basescan.org/tx/0x65b826b092e18403bcb298c22b7465eb8708839698228eb574f0aff2ba9475a0) | Y | `zk-api` | 48078588 | 54 553 | sí | 0,000000327318 |
| 11 | Registro · `publishCredentialRoot` (activación B) | [`0xa53d59a6…1612cf`](https://sepolia.basescan.org/tx/0xa53d59a6d36833df1b959691730eac5a9fe655b101b4009c0e191ed2211612cf) | Y | `zk-api` | 48078591 | 59 672 | sí | 0,000000358032 |
| 12 | Atestador · `attestFor(A)` | [`0xcee4d8ad…2b9860`](https://sepolia.basescan.org/tx/0xcee4d8adf46e97a74e4c4028eb88a6ff75d59b1a99bf87d89be2d227b62b9860) | Y | plataforma | 48078596 | 345 229 | sí | 0,000002071374 |
| 13 | Atestador · `attestFor(B)` | [`0x3becdb53…c037f0`](https://sepolia.basescan.org/tx/0x3becdb531aa7784db689368f906874eca5253e9f2e493054189b201ad4c037f0) | Y | plataforma | 48078609 | 345 229 | sí | 0,000002071374 |
| 14 | Token · `mint(A, 1000)` (agente) | [`0x8374d953…ff7869`](https://sepolia.basescan.org/tx/0x8374d95335ec5199dd63087ed1a31a81edd645c838f0fb51ed5a80c284ff7869) | Y | orquestador | 48078612 | 263 773 | sí | 0,000001582638 |
| 15 | Fondeo Y → A (0,000009845032 ETH) | [`0x679ab99a…36994a`](https://sepolia.basescan.org/tx/0x679ab99aef0624f5c541d1976e1f0cd71522db5b355f68b1c07fa5aa3136994a) | Y | orquestador | 48078614 | 21 000 | sí | 0,000000126000 |
| 16 | Token · `transfer(A → B, 250)` | [`0x652e8f9f…c4a983`](https://sepolia.basescan.org/tx/0x652e8f9f7c968f12c7d3e75d15b09295deffe18faa01cea0d89a5b39e8c4a983) | A | billetera de A | 48078616 | 252 000 | sí | 0,000001512000 |
| 17 | Registro · `publishCredentialRoot` (revocación de B) | [`0xaa9f2c42…3364f6`](https://sepolia.basescan.org/tx/0xaa9f2c42324665a09824321cbd2935dc7844a8329b5316d7a3b7e262dd3364f6) | Y | `zk-api` | 48078619 | 57 660 | sí | 0,000000345960 |
| 18 | Registro · `invalidateCredentialRoot` (raíz anterior) | [`0x784c1d5e…cb0fc8`](https://sepolia.basescan.org/tx/0x784c1d5e1e0b6887bc98744fb00f21a8f814c80c3146f635a984415856cb0fc8) | Y | `zk-api` | 48078621 | 28 005 | sí | 0,000000168030 |
| 19 | Atestador · `revokeAttestation(84532001, B)` | [`0xe3549ccb…5e5b3b`](https://sepolia.basescan.org/tx/0xe3549ccbb30a3ba6c5bb32c46f58617a9bb3b2e22b59c463a74c9376845e5b3b) | Y | orquestador | 48078624 | 29 476 | sí | 0,000000176856 |
| 20 | Token · `transfer(A → B, 100)`, rechazada | [`0xa59b8ff3…5ad2b6`](https://sepolia.basescan.org/tx/0xa59b8ff33ea41ba500a90c579fd4da80378073681b03b45058eb00cfb95ad2b6) | A | billetera de A | 48078628 | 214 984 | **revertida** | 0,000001289904 |
| 21 | Identidad C · `createIdentityWithManagementKeys` | [`0x80b2e071…4c31a2`](https://sepolia.basescan.org/tx/0x80b2e0715715e9880a5dc7df9833702b41d14eb7bf5b7b9389fca177234c31a2) | Y | orquestador | 48078662 | 451 825 | sí | 0,000002710950 |
| 22 | Identidad C · `addKey(ClaimIssuer, CLAIM)` | [`0xc0fdb054…8c799a`](https://sepolia.basescan.org/tx/0xc0fdb054cf40791ad757a6cb2038636445bd44764a4f22b33004e620a68c799a) | Y | orquestador | 48078664 | 179 071 | sí | 0,000001074426 |
| 23 | Identidad C · `addClaim` (tópico 1, firmado por Y) | [`0xd0b3e602…8374b0`](https://sepolia.basescan.org/tx/0xd0b3e602d9c3d21cb0c0077a5c194b2c88e0cd1403cde183b4851f8c7b8374b0) | Y | orquestador | 48078667 | 299 779 | sí | 0,000001798674 |
| 24 | IR · `registerIdentity(C, 840)` | [`0xa2cfcb78…605683`](https://sepolia.basescan.org/tx/0xa2cfcb78f744a7630ec307fc230768ec1de595d9b88f75cb36310619da605683) | Y | orquestador | 48078670 | 79 590 | sí | 0,000000477540 |
| 25 | Registro · `publishCredentialRoot` (activación C) | [`0x145a2b04…d1fb95`](https://sepolia.basescan.org/tx/0x145a2b0479edac75ed56000b53ea2f1287c639a9a8c22f9c0c773019bfd1fb95) | Y | `zk-api` | 48078673 | 59 672 | sí | 0,000000358032 |

Ninguna firma de los titulares es una transacción. La firma de posesión (EIP-712) y la prueba
nunca tocan la cadena desde la billetera del titular.

## Gas: quién lo paga

| Concepto | Transacciones | Gas | Coste (ETH) | Paga |
|---|---|---|---|---|
| Alta de inversores en el estándar (ONCHAINID, claim, IR), 3 inversores | 1–8, 21–24 | 3 030 771 | 0,000018184626 | Y |
| Escrituras de `zk-api` en el registro (jurisdicciones, 3 activaciones, revocación e invalidación) | 9–11, 17, 18, 25 | 329 040 | 0,000001974240 | Y |
| **Atestaciones `attestFor`**, 2 titulares | 12, 13 | 690 458 | 0,000004142748 | **Y** (los titulares, 0) |
| Acuñación como agente | 14 | 263 773 | 0,000001582638 | Y |
| Corte de la atestación de B | 19 | 29 476 | 0,000000176856 | Y |
| Fondeo de A (comisión; el valor enviado aparte) | 15 | 21 000 | 0,000000126000 | Y |
| Transferencia A → B y la rechazada | 16, 20 | 466 984 | 0,000002801904 | A |

| Billetera | Saldo de partida | Saldo final | Diferencia | Límite |
|---|---|---|---|---|
| Y | 0,049888311078083844 | 0,049852278938079214 | **0,000036032140** (comisiones 0,000026187108 + fondeo de A 0,000009845032) | 0,005 |
| X | 0,049805848021301816 | 0,049805848021301816 | **0** | 0,002 |
| A | 0 | 0,000007043127999744 | Recibió 0,000009845032 y gastó 0,000002801904 en sus dos transferencias | Sin límite |
| B | 0 | 0 | 0: no envió nada | Sin límite |
| C | 0 | 0 | 0: no envió nada | Sin límite |

La suma de los costes según los recibos difiere del cambio real de saldo de Y en **1 657 wei**
(0,0000000000000017 ETH). Se comprobó transacción por transacción, leyendo el saldo de Y en el bloque
anterior y en el del recibo: en diez de las 23 el campo `l1Fee` del recibo se separa del cobro real
en unas decenas o centenas de wei. Las cifras de saldo de arriba son las reales.

## Incidencias de la corrida

1. **1.ª corrida, detenida tras `attestFor(A)`.** La comprobación del orquestador comparaba el
   remitente del recibo (en minúsculas) con la dirección de Y (con mayúsculas de suma de
   comprobación) sin normalizar. La atestación estaba bien escrita: el propio log muestra
   `ComplianceAttested` con sujeto A y remitente Y. Se corrigió la comparación y se retomó, y la
   2.ª corrida resolvió A sin transacción nueva (`already_attested`, paso 6).
2. **2.ª corrida, detenida en el cierre.** La reconstrucción del árbol del activo respondió 424
   `chain_call_failed` («RPC Request failed»). El mensaje del orquestador, «el árbol de
   jurisdicciones no coincide con la cadena», era impreciso: no hubo discrepancia, sino un fallo de
   lectura de eventos que agotó los reintentos. Se corrigió el mensaje. Se ajustó
   `CHAIN_LOG_BLOCK_RANGE` en `.env.testnet` al rango que admite el endpoint (ver
   [Hallazgos](#hallazgos)), se reinició `zk-api` y la 3.ª corrida completó el cierre. Es solo
   lectura: no hay nada que reconciliar.
3. **Motivo de los rechazos.** En la 2.ª corrida el orquestador imprimió `"Error"` en lugar del
   texto del `require`, porque `revertName` devolvía el nombre del error (`Error(string)`) y no su
   argumento. Se corrigió en `zk-holder/src/presenter.ts`, con prueba unitaria. La 3.ª corrida
   simula de nuevo y deja el motivo: `"Transfer not possible"` y `"Compliance not followed"`.
4. **4.ª corrida.** Solo comprobaciones previas y resumen: 25 transacciones registradas, los mismos
   saldos. Demuestra que el orquestador no repite lo que ya está en cadena.

Ante errores de la API en activación o revocación, el orquestador reconcilia antes de seguir. No
hubo ninguno: las tres activaciones y la revocación respondieron bien a la primera.

## Hallazgos

1. **La reconstrucción se adapta al rango de consultas que admite el nodo.** Cuando el nodo
   rechaza una ventana de `eth_getLogs`, `zk-api` la parte a la mitad hasta que la acepta, como está
   diseñado, y la reconstrucción funcionó en el paso 11. Fijar `CHAIN_LOG_BLOCK_RANGE` al rango que
   admite el endpoint evita las llamadas rechazadas y la posibilidad de agotar los reintentos. El
   número de llamadas crece con la historia de la cadena (Base produce unos 43 000 bloques al día),
   así que el valor se ajusta al proveedor RPC que se elija. Es configuración, no código.
2. **La vigencia de una verificación sigue a la raíz, no a la atestación.** Tras revocar a B con
   `closeRootWindow: true`, la raíz contra la que A y B habían probado queda invalidada, y
   `GET /v1/verifications/:id` de **A** pasa también a `superseded_root`. Sin embargo, la atestación
   de A sigue viva y A sigue siendo conforme. Es el coste que el README ya declara para
   `closeRootWindow`. La consecuencia para el banco es que la pregunta «¿esta posición es conforme
   hoy?» se responde con `GET /v1/compliance/...`, no con la vigencia de una verificación anterior.
3. **Revocar no congela el saldo.** B sigue teniendo los 250 ZKCTA que recibió. El módulo solo mira
   al receptor, así que B ya no puede recibir, pero nada en la capa ZK le impide enviar a un
   receptor conforme. Si la política es inmovilizar, es un `freeze` o un `forcedTransfer` del agente
   del estándar. No se ejerció.

## Lo que no queda cubierto

- **No hay billetera real del inversor.** El lado del titular corre en el mismo proceso que el
  orquestador, con claves locales generadas para la prueba. No se usó una billetera embebida ni
  `eth_signTypedData_v4` a través de una interfaz. La firma es la misma operación EIP-712, pero no
  se probó que un proveedor de billeteras concreto la produzca igual.
- **La copia de seguridad no la custodia el titular.** Por ser una prueba, se guarda junto con su
  frase en el estado del orquestador (ignorado por git, fuera de la entrega). En producción la frase
  es del titular y la copia la conserva él.
- **La plataforma que presenta es este script con la clave de Y**, no un servicio. `zk-api` no tiene
  ruta de relay, por diseño.
- **La activación la envía el socio plataforma** con `credentials:activate`, en nombre del titular y
  con la firma de este. No se ejerció un reparto en el que la mesa que emite no pueda activar.
- **Solo Groth16.** El adaptador PLONK no está desplegado en Base Sepolia.
- **No se ejercieron en cadena:**
  - la renovación en el periodo siguiente;
  - la caducidad de una atestación por el paso del tiempo;
  - `AttestationWouldShorten`;
  - una copia del *mempool* hecha por un tercero. `NullifierAlreadySpent` solo se vio con la misma
    prueba presentada de nuevo por la propia plataforma.
- **No se ejercieron:**
  - la suspensión y la reactivación, ni la cancelación de una emisión pendiente;
  - la revocación sin cerrar la ventana de 900 s;
  - la denegación de una divulgación;
  - la rotación de claves de visualización.
- **El fallo ambiguo** (transacción minada con *rollback* en la base de datos) y la reconciliación
  tras un error de activación o revocación no se provocaron. El orquestador la tiene, pero no hizo
  falta.
- **La atribución del rechazo es por lectura.** En la red de pruebas no se desengancha el módulo
  para repetir la operación y ver que pasa, como sí hace la integración local
  (`refusalIsTheZkModules`): eso exigiría que X cambie la configuración del activo. Aquí la
  atribución se hace descartando cada regla del estándar y viendo que `moduleCheck` dice que no.
- **Todo en serie, un solo proceso firmante.** No se probaron activaciones concurrentes, carga ni
  límites de velocidad: eso es la fase de estrés.
- **Ni Mainnet, ni datos o bancos reales.** Identidades ficticias, sin KYC ni conexión bancaria.
- **El log del servicio `zk-api` no es evidencia.** Registra las cabeceras de cada petición,
  firmas de un solo uso incluidas, y se quedó fuera del repositorio.

## Cambios en `zk-api`

Uno solo, para poder correr contra Base Sepolia sin tocar la configuración de las pruebas:

- `src/config/index.ts` lee el fichero que indique `DOTENV_CONFIG_PATH` y, si no indica ninguno,
  `.env` como siempre.
- `package.json`: `start:testnet` y `prisma:migrate:testnet` (este con el nuevo
  `scripts/migrate-database.mjs`).
- Documentado en el `README.md` y en `.env.example`.
- Prueba nueva: `test/config-file.test.ts`, que arranca la configuración en un proceso aparte con
  entorno limpio y comprueba los dos casos.
- Suite: `tsc` limpio y **244/244**
  ([`2026-10-13_zk-api_suite-completa_entorno-testnet.log`](2026-10-13_zk-api_suite-completa_entorno-testnet.log)).

## Cliente del titular (`zk-holder`)

Paquete nuevo, sin *workspaces*, con su `README.md`. No importa `zk-api`. Las pruebas (25/25, sin
red, [`2026-10-13_zk-holder_pruebas-unitarias.log`](2026-10-13_zk-holder_pruebas-unitarias.log)) lo
comparan con el código del propio emisor, cargado con una configuración desechable:

- la copia cifrada se abre a la ida y a la vuelta, también con la del emisor en los dos sentidos;
  la frase equivocada y la manipulación se rechazan;
- `secretHash`, compromiso y nulificador coinciden con los del emisor, y la raíz recalculada desde
  la apertura del árbol del emisor es la suya;
- una prueba generada verifica contra `zk-circuits/build/groth16.vkey.json`, deja de verificar al
  mover cualquiera de las seis señales y se codifica en 256 bytes para `attestFor`. Un país no
  admitido no tiene testigo;
- la firma de posesión se recupera al titular, también con la recuperación del emisor, y no se
  recupera con otra credencial, otro hash u otra cadena;
- la firma HMAC del socio es idéntica a la del servicio;
- un revert se lee por su nombre de error o por el texto de su `require`.

## Logs

| Log | Contenido |
|---|---|
| [`2026-10-13_e2e_base-sepolia_ciclo-completo.log`](2026-10-13_e2e_base-sepolia_ciclo-completo.log) | Las cuatro corridas del orquestador, en orden y sin editar. Las claves, los secretos de socio, los secretos de los titulares y las frases de las copias se sustituyen por `[redacted]` antes de escribir cada línea. Se comprobó después contra los 60 valores secretos del estado y de los `.env`: ninguno aparece |
| [`2026-10-13_zk-holder_pruebas-unitarias.log`](2026-10-13_zk-holder_pruebas-unitarias.log) | `npm run typecheck && npm test -- --reporter=verbose` en `zk-holder`: 25/25 |
| [`2026-10-13_zk-api_suite-completa_entorno-testnet.log`](2026-10-13_zk-api_suite-completa_entorno-testnet.log) | `npm run typecheck && npm test` en `zk-api` tras el cambio: 244/244 |

## Cómo reproducir

```bash
docker start zk-api-postgres zk-api-redis
cd zk-api && npm run prisma:migrate:testnet && npm run start:testnet   # en otra terminal
cd zk-holder && npm install && npm run e2e:base-sepolia
```

Para una corrida nueva desde cero (billeteras y socios nuevos), basta con mover
`zk-holder/e2e/state/base-sepolia.json`. El orquestador se detiene solo si Y gasta más de 0,005 ETH
o X más de 0,002 ETH.
