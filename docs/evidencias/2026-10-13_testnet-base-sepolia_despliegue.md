# Despliegue en Base Sepolia: 13/10/2026

Red de pruebas **Base Sepolia** (`chainId` 84532). Explorador: <https://sepolia.basescan.org>.

Fuente de verdad: `zk-contracts/deployments/baseSepolia.json`, que escribe el propio script de
despliegue con cada dirección, transacción, bloque y gas. Lo de abajo se copió de ese archivo y
de los logs crudos.

## Estado

| Bloque | Estado |
|---|---|
| 1. Capa de confidencialidad (verificador, adaptador, registro, atestador, módulo) | Hecho |
| 2. Roles de la plataforma en el registro y el atestador | Hecho |
| 3. Activo de prueba con la fábrica T-REX compartida (`deployTREXSuite`) y `unpause` | Hecho, firmado por Y. La creación se hizo en una tercera corrida que retomó el estado registrado sin reenviar ninguna transacción |
| Verificación en Basescan | Hecho: 6 de 6 (los 5 contratos propios y el `ModuleProxy`); la suite T-REX son proxies del estándar (ver más abajo) |
| Comprobación de cableado en cadena | Hecha sobre todo el despliegue: 40 de 40, 0 fallidas |

## Billeteras

| | Dirección | Papel |
|---|---|---|
| X | [`0xb44703b4D47Fd595f6383909aCF424cA6612A5C2`](https://sepolia.basescan.org/address/0xb44703b4D47Fd595f6383909aCF424cA6612A5C2) | Despliegue (fría). Administra el registro y el atestador, es dueña del módulo y dueña del activo |
| Y | [`0xbddD8970657eb2B08f6E6bc78abB3f5c2B8d4337`](https://sepolia.basescan.org/address/0xbddD8970657eb2B08f6E6bc78abB3f5c2B8d4337) | Plataforma (caliente). Emisor de credenciales, jurisdicciones, gestión de atestaciones; dueña de la fábrica T-REX y agente del activo |

El script no confía en estas direcciones escritas a mano: toma Y como el `owner()` de la fábrica
T-REX y exige que X sea el `owner()` de su `TREXImplementationAuthority`. Si alguna clave no
corresponde, aborta antes de enviar nada.

## Parámetros

| Parámetro | Valor | Por qué |
|---|---|---|
| `ASSET_ID` | **`84532001`** | El `chainId` seguido de un ordinal: primer activo confidencial de esta red. Distinto de 0, como exige `setAssetId` |
| Salt de la suite | **`ZKCONF-20261013`** | Nuevo y único. Antes del despliegue `TREXFactory.getToken("ZKCONF-20261013")` devolvía `0x0` |
| Activo de prueba | `ZK Confidential Test Asset` · `ZKCTA` · 18 decimales | Nombre que no se confunde con ningún activo real |
| Ventana de validez de raíces | 900 s | La que usan las pruebas |
| Periodo de atestación | 2 592 000 s (30 días) | Ídem |
| `REGISTRY_DEPLOYMENT_BLOCK` | **`48076954`** | Bloque de la transacción que creó `CredentialRegistry`; desde ahí lee eventos `zk-api` |

## Contratos

| Contrato | Dirección | Bloque | Verificado |
|---|---|---|---|
| `Groth16Verifier` | [`0xD5417e562083DB6ef071489f2d1A8C0d8d36784d`](https://sepolia.basescan.org/address/0xD5417e562083DB6ef071489f2d1A8C0d8d36784d#code) | 48076942 | Sí |
| `Groth16VerifierAdapter` | [`0xC2e0400Fedbbb9D200228cFf3D5e95dB26dcbbaA`](https://sepolia.basescan.org/address/0xC2e0400Fedbbb9D200228cFf3D5e95dB26dcbbaA#code) | 48076951 | Sí |
| `CredentialRegistry` | [`0xA3fcAb3e8da5546BeBE66A88E581621a8b27B8AA`](https://sepolia.basescan.org/address/0xA3fcAb3e8da5546BeBE66A88E581621a8b27B8AA#code) | 48076954 | Sí |
| `ComplianceAttestor` | [`0x83C0429F5b15CBC5d4eE0Fc7e74b23A23daB9D09`](https://sepolia.basescan.org/address/0x83C0429F5b15CBC5d4eE0Fc7e74b23A23daB9D09#code) | 48076957 | Sí |
| `ZKComplianceModule` (implementación) | [`0x7d818cDE9804F0A9311321720D1aE5cCe8c4abCf`](https://sepolia.basescan.org/address/0x7d818cDE9804F0A9311321720D1aE5cCe8c4abCf#code) | 48076960 | Sí |
| `ModuleProxy` del módulo (**la dirección que se engancha**) | [`0x80929BFc966888fa24710F177F594F377A64A925`](https://sepolia.basescan.org/address/0x80929BFc966888fa24710F177F594F377A64A925#code) | 48076962 | Sí |

El `Groth16Verifier` desplegado es el del repositorio, que corresponde a la clave de prueba
`zk-circuits/build/groth16.zkey`. No se regeneraron claves.

Contratos compartidos que se usaron sin modificarlos (ni `transferOwnership`, ni `addKey`, ni
cambios de configuración):

| Contrato | Dirección |
|---|---|
| `TREXFactory` | [`0x599e0AC637FD3B598b13bbB1729EC4ed967875fF`](https://sepolia.basescan.org/address/0x599e0AC637FD3B598b13bbB1729EC4ed967875fF) |
| `TREXImplementationAuthority` | [`0x13Ff944065646E8405aDD12EdDaBFd07bDaa6Fd8`](https://sepolia.basescan.org/address/0x13Ff944065646E8405aDD12EdDaBFd07bDaa6Fd8) |
| `ClaimIssuer` (emisor de confianza, tópico 1) | [`0xD60B8E767c0f830b95Fc0cD87B71643c47aF9492`](https://sepolia.basescan.org/address/0xD60B8E767c0f830b95Fc0cD87B71643c47aF9492) |

### El `ModuleProxy` y su verificación

`ModuleProxy` es el proxy ERC-1967 que publica `@erc3643org/erc-3643` 4.1.3, y se desplegó desde
el bytecode del paquete, con `initialize(attestor)` en el propio constructor. El paquete trae el
código fuente y el bytecode pero no la información de compilación, y la verificación con el
complemento de Hardhat no sirve: al compilarlo dentro de este proyecto la fuente queda bajo la ruta
`@erc3643org/erc-3643/contracts/...`, y esa ruta forma parte del hash de metadatos que va al final
del bytecode. El código ejecutable es idéntico, pero los metadatos no.

Se comprobó fuera de la cadena que con la ruta original del paquete
(`contracts/compliance/modular/modules/ModuleProxy.sol`), solc 0.8.17, optimizador a 200 y las
fuentes de OpenZeppelin 4.9.x el bytecode coincide **byte a byte**, metadatos incluidos.
`scripts/verify-explorer.ts` arma esa entrada JSON estándar y la envía directamente a la API v2 de
Etherscan. Resultado: `Pass - Verified`.

## Activo T-REX creado

Creado por Y con una sola llamada a `TREXFactory.deployTREXSuite("ZKCONF-20261013", …)`, en el
bloque 48077701.

| Contrato | Dirección | Bloque |
|---|---|---|
| `Token` (ZKCTA) | [`0xFf6542a477300EEfD8F1BBFB32dB5e4213941CCa`](https://sepolia.basescan.org/address/0xFf6542a477300EEfD8F1BBFB32dB5e4213941CCa) | 48077701 |
| `IdentityRegistry` (IR) | [`0x24F8961FE7B61689767A21FC9Fc303611BcAdBd0`](https://sepolia.basescan.org/address/0x24F8961FE7B61689767A21FC9Fc303611BcAdBd0) | 48077701 |
| `IdentityRegistryStorage` (IRS) | [`0xd7c0621abF44b569AC15F77D018929eedA3A9C5b`](https://sepolia.basescan.org/address/0xd7c0621abF44b569AC15F77D018929eedA3A9C5b) | 48077701 |
| `TrustedIssuersRegistry` (TIR) | [`0x3C15F2CDE30e1A707E493afcE3fd27C8e7a20bEA`](https://sepolia.basescan.org/address/0x3C15F2CDE30e1A707E493afcE3fd27C8e7a20bEA) | 48077701 |
| `ClaimTopicsRegistry` (CTR) | [`0xe98Cf55fFfe542429229eeacfBa5e453555aE78f`](https://sepolia.basescan.org/address/0xe98Cf55fFfe542429229eeacfBa5e453555aE78f) | 48077701 |
| `ModularCompliance` (MC) | [`0x70a5c8351D632bFcAAb56772f0359B0652B8FCD2`](https://sepolia.basescan.org/address/0x70a5c8351D632bFcAAb56772f0359B0652B8FCD2) | 48077701 |

Son los proxies del estándar T-REX que crea la fábrica compartida; apuntan a las implementaciones
de la `TREXImplementationAuthority`, que ya figuran verificadas en el explorador. Por eso no
forman parte de `verify:base-sepolia`, que solo publica los cinco contratos propios y el
`ModuleProxy`. La verificación de las implementaciones no la hizo este proyecto.

### Configuración comprobada en cadena

Comprobación de solo lectura en el bloque 48077709 (`check:base-sepolia`, 40 de 40):

| Elemento | Valor comprobado |
|---|---|
| Dueño (`owner`) del token, de `ModularCompliance` y de `IdentityRegistry` | X |
| Agente del token y del `IdentityRegistry` | Y |
| Tópicos de reclamación (`ClaimTopicsRegistry`) | `[1]` |
| Emisores de confianza (`TrustedIssuersRegistry`) | `ClaimIssuer` [`0xD60B8E767c0f830b95Fc0cD87B71643c47aF9492`](https://sepolia.basescan.org/address/0xD60B8E767c0f830b95Fc0cD87B71643c47aF9492), con el tópico 1 |
| Módulos de `ModularCompliance` | Solo el `ModuleProxy` del módulo ZK, enlazado en ambos sentidos |
| `assetId` del módulo ZK para esa `ModularCompliance` | `84532001`, y el camino inverso devuelve la misma `ModularCompliance` |
| `Token.paused()` | `false` |
| `TREXFactory.getToken("ZKCONF-20261013")` | La dirección del token |

## Transacciones

Firmante, gas consumido y coste total (gas L2 × precio efectivo + tarifa L1 de Base). Precio
efectivo en todas: 0,006 gwei.

| # | Paso | Hash | Firmó | Bloque | Gas | Coste (ETH) |
|---|---|---|---|---|---|---|
| 1 | Despliega `Groth16Verifier` | [`0x61fdef52…f79f26`](https://sepolia.basescan.org/tx/0x61fdef52cfb91b7f7b1dae692dd5de77dc5513fbb3d834d849ad99a2a8f79f26) | X | 48076942 | 450 287 | 0,000002701722 |
| 2 | Despliega `Groth16VerifierAdapter(verifier)` | [`0xca691565…8cf001`](https://sepolia.basescan.org/tx/0xca69156573076ba612b484e9c43d95017fc50a15a3da8505c46d0b75608cf001) | X | 48076951 | 316 959 | 0,000001901754 |
| 3 | Despliega `CredentialRegistry(X, 900)` | [`0xb1a628e1…64e38a`](https://sepolia.basescan.org/tx/0xb1a628e198247a140311056dcf3c3a2847f0092dec4460366ded4b07b064e38a) | X | 48076954 | 1 189 339 | 0,000007136034 |
| 4 | Despliega `ComplianceAttestor(X, registry, adapter, 2592000)` | [`0x0f089bcb…bb0239`](https://sepolia.basescan.org/tx/0x0f089bcbc6894296f484b5a6cc7f901f881431fa3b2379256194315b8abb0239) | X | 48076957 | 1 456 240 | 0,000008737440 |
| 5 | Despliega la implementación de `ZKComplianceModule` | [`0x5de75140…145577`](https://sepolia.basescan.org/tx/0x5de75140e61de803d135023851349bf35dbe29181b5f83befcd6fecfa7145577) | X | 48076960 | 1 410 208 | 0,000008461248 |
| 6 | Despliega `ModuleProxy(impl, initialize(attestor))` | [`0x98bb233d…b8e5aa`](https://sepolia.basescan.org/tx/0x98bb233d70cf59b6446b87d466141af46f67cb553dc91f6b3e69252169b8e5aa) | X | 48076962 | 322 783 | 0,000001936698 |
| 7 | `registry.grantRole(ISSUER_ROLE, Y)` | [`0x97ff3d84…1263fe`](https://sepolia.basescan.org/tx/0x97ff3d84662144c0752e3d678e9606e9a94ae8069d12ec188eb4bf49141263fe) | X | 48076964 | 51 523 | 0,000000309138 |
| 8 | `registry.grantRole(JURISDICTION_ROLE, Y)` | [`0xdbdab6ec…b2f878`](https://sepolia.basescan.org/tx/0xdbdab6ec42fdc9895df5c413458e1479321c13dc11bb437485716d5804b2f878) | X | 48076967 | 51 523 | 0,000000309138 |
| 9 | `attestor.grantRole(ATTESTATION_MANAGER_ROLE, Y)` | [`0x6389a4f8…71cff5`](https://sepolia.basescan.org/tx/0x6389a4f80d1497f527da6a6b27ebf6d86c38eccb6b6e5ec2bc242c934571cff5) | X | 48076970 | 51 429 | 0,000000308574 |
| 10 | `TREXFactory.deployTREXSuite("ZKCONF-20261013", …)` | [`0xa4eecff3…5920f6`](https://sepolia.basescan.org/tx/0xa4eecff3d8b55456f7cb0bc345f93b94005dff13ffb1ade3a8ae3816705920f6) | Y | 48077701 | 3 857 517 | 0,000023145102 |
| 11 | `Token.unpause()` | [`0xb670c7f8…27619a`](https://sepolia.basescan.org/tx/0xb670c7f8122c00cf59cf75aac69c2b63afafb5a8f3cc4a1ae084f6125c27619a) | Y | 48077704 | 42 678 | 0,000000256068 |

Gasto total: **X 0,000031801746 ETH** (saldo 0,049837649767 → 0,049805848021 ETH; la diferencia
coincide al wei con la suma de las transacciones 1 a 9) e **Y 0,000023401170 ETH** (saldo
0,049911712248 → 0,049888311078 ETH, la suma de las transacciones 10 y 11).

## Quién tiene cada rol

| Contrato | Rol | X | Y |
|---|---|---|---|
| `CredentialRegistry` | `DEFAULT_ADMIN_ROLE` | Sí | No |
| `CredentialRegistry` | `ISSUER_ROLE` (publica raíces de credenciales) | No | Sí |
| `CredentialRegistry` | `JURISDICTION_ROLE` (publica raíces de jurisdicciones por activo) | No | Sí |
| `ComplianceAttestor` | `DEFAULT_ADMIN_ROLE` (cambia verificador y periodo) | Sí | No |
| `ComplianceAttestor` | `ATTESTATION_MANAGER_ROLE` (revoca atestaciones) | No | Sí |
| `ZKComplianceModule` (proxy) | `owner` (cambia atestador, libera `assetId`, autoriza actualizaciones) | Sí | No |

En el activo creado: `owner` del token, del `IdentityRegistry` y del `ModularCompliance` → X;
agente del token y del `IdentityRegistry` → Y (comprobado en cadena). `attestFor` puede llamarlo cualquiera: la plataforma
lo presentará con Y.

## Cómo se engancha el módulo

La fábrica T-REX enganchó el módulo dentro de `deployTREXSuite`: por cada módulo hace `addModule`
y luego `callModuleFunction(complianceSettings[i])` mientras todavía es dueña del
`ModularCompliance`, y solo al final transfiere la propiedad a `owner`. Con
`complianceModules = [0x80929BFc…A925]` y `complianceSettings = [setAssetId(84532001)]`, el activo
nació con el módulo ZK enganchado y el `assetId` ligado, sin transacciones extra. Solo va el módulo
ZK: la jurisdicción la prueba el circuito.

## Logs crudos

| Log | Contenido |
|---|---|
| `2026-10-13_zk-contracts_despliegue-base-sepolia_corrida-1-interrumpida.log` | Primera corrida: envió el despliegue del verificador y se cortó al esperar el recibo (el proveedor de Hardhat no implementa `waitForTransaction`). El hash quedó registrado como pendiente |
| `2026-10-13_zk-contracts_despliegue-base-sepolia_corrida-2-capa-y-roles.log` | Segunda corrida: retoma esa misma transacción sin reenviarla, despliega el resto, concede los roles y se detiene antes de la suite |
| `2026-10-13_zk-contracts_despliegue-base-sepolia_corrida-3-activo-trex.log` | Tercera corrida: retoma el estado registrado sin reenviar nada, crea la suite T-REX con Y y la despausa |
| `2026-10-13_zk-contracts_verificacion-basescan.log` | Verificación de los 6 contratos |
| `2026-10-13_zk-contracts_verificacion-basescan_repeticion.log` | Segunda corrida: los 6 aparecen como ya verificados, sin errores |
| `2026-10-13_zk-contracts_cableado-base-sepolia_capa-y-roles.log` | Comprobación de cableado en cadena, solo lectura, antes de crear el activo: 19 de 19 |
| `2026-10-13_zk-contracts_verificacion-basescan_con-activo.log` | Verificación con el activo ya creado: los 6 contratos siguen verificados, 0 fallidos |
| `2026-10-13_zk-contracts_cableado-base-sepolia_completo.log` | Comprobación de cableado completa, incluida la suite T-REX: 40 de 40 |
| `2026-10-13_zk-contracts_suite-completa_tras-despliegue.log` | `npx hardhat test` tras añadir la configuración del explorador: 120 de 120 |

Los logs y el registro se revisaron en busca de claves y URLs con clave: ninguna aparece. Los
scripts tapan esos valores en su propia salida.
