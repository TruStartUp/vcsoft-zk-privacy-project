# Notas técnicas de servicios

Especificación de `zk-api`: el emisor de credenciales, el servicio de divulgación autorizada y la
API de verificación. Recoge el diseño implementado, sus esquemas criptográficos, las garantías con
sus fronteras y los riesgos abiertos con su condición de disparo. El circuito y los contratos se
especifican en `../zk-circuits/NOTAS-CIRCUITO.md` (en adelante, NC); la operación diaria, en
`docs/MANUAL-USUARIO-Y-OPERACION.md` (en adelante, el manual).

## Índice

1. Emisión de credenciales: 1.1 Material criptográfico · 1.2 Emisión en dos tiempos ·
   1.3 Prueba de posesión · 1.4 Dominio EIP-712 · 1.5 Unicidad y referencia de sujeto
2. Secreto del titular: 2.1 Generación y copia cifrada · 2.2 Derivación por firma ·
   2.3 Reproducibilidad de la firma · 2.4 Requisitos de la aplicación del inversor ·
   2.5 Pérdida de la billetera
3. Árboles y escritura en cadena: 3.1 Construcción de los árboles · 3.2 Escritura transaccional ·
   3.3 Revocación, suspensión y cancelación · 3.4 Jurisdicciones · 3.5 Operaciones a medias
4. Divulgación autorizada: 4.1 Esquema criptográfico · 4.2 Custodia de las claves de
   visualización · 4.3 Rotación · 4.4 Solicitud, decisión y liberación · 4.5 Separación de partes
5. API de verificación: 5.1 Autenticación de socios · 5.2 Alcances · 5.3 Verificación de pruebas ·
   5.4 Frontera del esquema de prueba · 5.5 Estado de cumplimiento y de credencial ·
   5.6 Registro de accesos · 5.7 Especificación OpenAPI
6. Relación con la cadena: 6.1 Transporte JSON-RPC · 6.2 Envíos y recibos ·
   6.3 Lecturas coherentes · 6.4 Reconstrucción y reconciliación · 6.5 ABI del servicio
7. Riesgos abiertos: 7.1 a 7.20
8. Cobertura de pruebas

---

## 1. Emisión de credenciales

### 1.1 Material criptográfico

```
secret     = lo genera y lo conserva el inversor; el emisor no lo ve nunca
secretHash = Poseidon(secret)                        lo único que recibe el emisor
commitment = Poseidon(secretHash, country, expiry)   lo construye el emisor
nullifier  = Poseidon(secret, assetId, epochEnd)     solo lo calcula el inversor
```

El emisor fija `country` y `expiry`, que salen del KYC, y revoca quitando la hoja. No puede
calcular un nulificador ni construir un testigo, porque ambos exigen la preimagen; su única vía hacia
la identidad es el sobre cifrado, que pasa por el flujo registrado de divulgación (§4). El control
de duplicados está en la base de datos (§1.5).

### 1.2 Emisión en dos tiempos

| Paso | Quién | Qué ocurre |
|---|---|---|
| 1 | la mesa de emisión, alcance `credentials:issue` | `POST /v1/credentials` con el veredicto del KYC, la identidad y `holderAddress`. La fila nace `PENDING`, sin compromiso ni posición de hoja, y la identidad queda sellada (§4.1). |
| 2 | la aplicación del inversor, alcance `credentials:activate` | `POST /v1/credentials/:credentialId/activation` con `secretHash` y la firma de posesión (§1.3). Se construye la hoja y se publica la raíz (§3.2). |

Quien registra el veredicto no puede completar la credencial por el titular. La respuesta del paso 1
incluye los dos mensajes EIP-712 que firmará la billetera. `PENDING` se suma a `ACTIVE`,
`SUSPENDED`, `EXPIRED` y `REVOKED`; `GET /v1/credentials/:commitment` no lo devuelve, porque una
pendiente no tiene compromiso. Una pendiente se cancela con
`POST /v1/credentials/:credentialId/cancellation`, que no publica nada.

### 1.3 Prueba de posesión

La activación exige la firma EIP-712 de la billetera registrada sobre:

```
CredentialActivation(string credentialId, string secretHash)
```

El servicio recupera el firmante y lo compara con `holderAddress`. La firma no se puede reutilizar en
otra credencial pendiente ni con otro hash, porque ambos están dentro de lo firmado. Cierra dos
ataques: que el emisor sustituya el hash por uno propio, cuyo compromiso sería indistinguible de uno
legítimo, y que un tercero que conozca el identificador de una credencial pendiente registre su hash
antes que el titular. Es un mensaje distinto del de derivación (§2.2), así que no dice nada del
secreto. La activación rechaza además direcciones con código (`holder_is_contract_account`).

### 1.4 Dominio EIP-712

```
domain = { name: "VCSoft Confidentiality Layer", version: "1",
           chainId, verifyingContract: <CredentialRegistry> }
```

La billetera muestra contenido estructurado y el origen que lo pide (defensa frente al *phishing*);
la misma billetera produce un `secretHash` distinto en cada despliegue (dos credenciales en dos
entidades no se vinculan); y una firma pedida desde otro sitio no produce el hash de este sistema,
lo que importa porque un `secretHash` filtrado permite recuperar `country` y `expiry` de su
compromiso con unas 10⁵ evaluaciones de Poseidon. El dominio está fijado y versionado: cambiarlo
cambia todos los secretos derivados y equivale a reemitir toda la población.

### 1.5 Unicidad y referencia de sujeto

- **Una credencial viva por sujeto**: índice único parcial sobre `subjectRef` para `PENDING`,
  `ACTIVE` y `SUSPENDED` (`credential_already_issued`). Una revocada deja de bloquear, lo que permite
  reemitir tras perder la billetera (§2.5).
- **Un `secretHash` por sistema**: índice único global. Detecta una billetera detrás de dos
  identificadores de KYC; no detecta dos billeteras de la misma persona (§7.3).

`subjectRef = HMAC(SUBJECT_REFERENCE_KEY, kycSubjectId)`. La clave no sella ni abre nada: perderla
cuesta el control de duplicados, no una credencial. La caducidad no libera el hueco por sí sola: una
credencial vencida lo ocupa hasta que se revoca.

---

## 2. Secreto del titular

### 2.1 Generación y copia cifrada

La vía de referencia, implementada en `src/lib/holder-secret.ts` y, con la misma envoltura, en el
cliente de referencia `zk-holder`:

- `randomHolderSecret()`: secreto uniforme en el campo, por muestreo con rechazo;
- `sealHolderSecret(secret, passphrase)` y `openHolderSecret(...)`: copia de seguridad cifrada con
  scrypt (`N = 2^16`, `r = 8`, `p = 1`, sal de 16 bytes, frase normalizada NFKC de al menos 12
  caracteres) y AES-256-GCM, con datos asociados versionados
  (`vcsoft/zk-api/holder-secret-backup/v1`). Recuperar es descifrar.

`holder-secret.ts` es una implementación de referencia para el cliente: el servicio solo importa
`recoverActivationSigner`. El secreto y la copia nunca pasan por el servicio.

### 2.2 Derivación por firma

Vía opcional, implementada y probada, para quien necesite reconstruir el secreto a partir de una
firma EIP-712 del mensaje `CredentialSecret`:

```
secret = SHA-512("vcsoft/zk-api/holder-secret/v1" || r || low-s(s)) mod p
```

Se descarta el byte de recuperación `v` (las billeteras no coinciden en 27/28 o 0/1) y `s` se pliega
a su mitad baja (EIP-2), porque `(r, s)` y `(r, n − s)` son firmas válidas del mismo mensaje. El
sesgo de la reducción es inferior a 2⁻²⁵⁰ (NC §7.3). La firma de derivación no se transmite, no se
registra y no se verifica en ningún sitio.

### 2.3 Reproducibilidad de la firma

**La firma de la billetera no es reproducible en general; por eso la aplicación del inversor conserva
el secreto en una copia cifrada y no lo deriva de una firma.** ECDSA admite un nonce aleatorio, y el
determinismo depende de que la implementación aplique RFC 6979, que ningún EIP exige; además, la
clave de una billetera embebida puede cambiar con el método de acceso. La biblioteca de firma de la
pila (viem) es determinista por defecto, y la suite falla si ese valor por defecto cambia.

El servicio rechaza direcciones con código, pero una cuenta ERC-4337 aún no desplegada pasa y una
billetera MPC es indistinguible de una EOA: la defensa real es la copia cifrada. Cambiar de tipo de
billetera implica un secreto y un compromiso nuevos (§2.5).

### 2.4 Requisitos de la aplicación del inversor

Son requisito de aceptación de la aplicación cliente:

1. generar o derivar el secreto una sola vez, en la activación;
2. cifrarlo bajo una frase del titular y entregarle la copia antes de completar la activación;
3. no depender de la firma para reconstruirlo.

Detalle para el desarrollador en el manual, §29 a §32.

### 2.5 Pérdida de la billetera

Nadie, tampoco el emisor, puede reconstruir el secreto. Con la copia cifrada, el inversor lo
recupera descifrándola. Si se pierden a la vez la billetera y la copia, la credencial no queda
comprometida sino inutilizable, y el procedimiento es: verificación renovada de la persona por el
banco (lo único que distingue una pérdida de una suplantación), revocación o cancelación de la
credencial, corte de las atestaciones vivas con `revokeAttestation` y emisión nueva para el mismo
`subjectRef`, que la revocación liberó. El emisor no admite una segunda dirección de activación:
equivaldría a sustituir el `secretHash` de una credencial viva. Pasos y respuestas esperadas en el
manual, §14.1 y §31.

---

## 3. Árboles y escritura en cadena

### 3.1 Construcción de los árboles

El árbol de credenciales (20 niveles) y el de jurisdicciones de cada activo (8 niveles) se
construyen desde las filas cada vez que hacen falta, con una única vía de construcción. Las hojas
vacías valen `0` y el relleno es el digest del subárbol de ceros, igual que en el generador de
pruebas de los contratos; la suite reproduce las raíces de esas *fixtures*. El coste es lineal en el
número de hojas (§7.20).

### 3.2 Escritura transaccional

La activación asigna la posición de hoja, escribe el compromiso, calcula la raíz y la publica dentro
de una transacción de PostgreSQL con *advisory lock*. Si el registro rechaza la raíz, la fila vuelve
a `PENDING` sin compromiso ni posición. El paso 1 no toca la cadena, y una credencial que no se
activa no consume posición.

Los cambios de un mismo árbol esperan turno en memoria dentro del proceso, y solo el que está en
curso ocupa una conexión; el *advisory lock* ordena entre procesos. Con más de
`ISSUER_WRITE_QUEUE_LIMIT` cambios en espera (16 por defecto), el siguiente se rechaza antes de tocar
nada con `503 service_busy` y `Retry-After`; un agotamiento del *pool* que llegue a la respuesta sale
igual. La duración máxima de la transacción se deriva de `CHAIN_RECEIPT_TIMEOUT_MS`.

### 3.3 Revocación, suspensión y cancelación

Revocar y suspender quitan la hoja y publican la raíz sin ella; solo la suspensión es reversible, y
una credencial caducada no se reinstaura (`credential_expired`). Revocar una suspendida la retira sin
publicar nada, haya caducado o no, y libera el hueco del sujeto. Las posiciones de hoja no se
reutilizan: un compromiso nuevo en la posición de uno revocado haría que una apertura antigua,
contra una raíz aún dentro de la ventana, apuntara a otra hoja.

**Cierre de la ventana.** Contra la raíz sustituida, aceptada durante `rootValidityWindow`, el
compromiso revocado aún prueba pertenencia. Por defecto, revocar y suspender la invalidan con
`invalidateCredentialRoot` (`previousRootInvalidated` en la respuesta). El coste es que se rechazan
también las pruebas de otros titulares contra esa raíz, que piden su apertura y prueban de nuevo;
`{"closeRootWindow": false}` omite el cierre. Las atestaciones concedidas siguen hasta el fin de su
periodo (NC §5.2) y los saldos no se congelan (manual, §7.3).

### 3.4 Jurisdicciones

`POST /v1/assets/:assetId/jurisdictions` publica el conjunto de países admitidos de un activo. Si el
cambio retira algún país, el servicio invalida la raíz anterior con `invalidateCountryRoot` (el
emisor tiene `JURISDICTION_ROLE`), con el mismo coste y la misma opción `closeRootWindow: false`.
Añadir países no cierra nada.

### 3.5 Operaciones a medias

Cuando la cadena confirma una escritura que la base de datos deshizo, repetir la misma petición la
completa:

- **Adopción.** Si publicar revierte y la raíz vigente del registro es exactamente la calculada, el
  servicio busca el evento `CredentialRootPublished` o `CountryRootPublished` de esa raíz desde la
  última publicación anotada y, si su transacción no está anotada, la anota como propia: una raíz
  igual implica el mismo árbol.
- **Cierre pendiente.** Si la invalidación de la raíz anterior falla, el cambio se confirma igualmente
  (`invalidationRequested`) y la respuesta es `424 root_invalidation_pending`; repetir reintenta solo
  el cierre, y si la raíz ya no valida lo da por hecho sin enviar nada.

**Frontera.** Ante `chain_receipt_timeout` se reconcilia antes de hacer otro cambio, porque se
calcularía sin conocer el primero (manual, §14.2). Una base de datos restaurada o una reorganización
más profunda que `CHAIN_CONFIRMATIONS` son incidentes (§7.9, §7.18).

---

## 4. Divulgación autorizada

### 4.1 Esquema criptográfico

**X25519 ECDH-ES + HKDF-SHA256 + AES-256-GCM**, con un par efímero por sobre:

- **Cifrado autenticado**: editar el criptograma o el tag hace fallar la apertura.
- **Sellado con la mitad pública**: dar de alta a un titular no requiere la clave que abre, y dos
  sellados del mismo dato difieren.
- **HKDF con sal `ephemeralPublic || recipientPublic`**: la clave queda ligada a las dos mitades.
- **Datos asociados** `vcsoft/zk-api/identity/v1`, identificador de fila de la credencial y
  `viewingKeyId`: un sobre movido a otra credencial falla en lugar de nombrar a otra persona. Es el
  identificador de fila porque la identidad se sella antes de que exista el compromiso.
- **AES-256-GCM** por su disponibilidad en HSM y módulos validados, con clave y nonce nuevos por sobre.

### 4.2 Custodia de las claves de visualización

Las claves privadas entran por `DISCLOSURE_VIEWING_KEYS` (pares `id:base64`), con la activa en
`DISCLOSURE_ACTIVE_VIEWING_KEY`, y en producción viven en el gestor de secretos del entorno. La base
de datos guarda `viewingKeyId`, la pública efímera, el nonce, el tag, el criptograma y los datos
asociados; nunca la identidad en claro ni la clave privada.

### 4.3 Rotación

La clave nueva se añade a `DISCLOSURE_VIEWING_KEYS` junto a la vigente y pasa a ser la activa;
`POST /v1/disclosures/viewing-keys/rotation` abre cada sobre con su clave y lo vuelve a sellar con un
par efímero nuevo, pasando de largo los que no puede abrir, y responde `rotated`, `alreadyCurrent`,
`failed` y `remaining`. La clave sustituida se retira solo cuando `remaining` es `0`; retirarla antes
deja sobres que no se pueden abrir hasta que vuelva. La rotación no toca la cadena ni invalida
pruebas. Procedimiento en el manual, §9.1.

### 4.4 Solicitud, decisión y liberación

Cada solicitud guarda el socio y el solicitante real detrás de él (`requesterRef`), la
justificación, la base legal, el compromiso, el alcance, la fecha, la firma HMAC del socio sobre esos
bytes y un digest canónico. Es no repudio operativo: como el servicio conserva una copia envuelta del
secreto del socio para verificar, no es una firma oponible frente a terceros (§7.6).

La decisión solo se escribe si la solicitud sigue `PENDING`, y la liberación pasa a `RELEASED` en la
misma transacción que abre el sobre: no hay doble decisión ni doble liberación, y un sobre que no
abre no deja la solicitud liberada. La liberación devuelve solo los atributos del alcance aprobado, y
esos atributos no llegan al registro de accesos.

### 4.5 Separación de partes

La regla se aplica por solicitud, tenga el socio los alcances que tenga:

- **Quien pidió no decide**: aprobar o denegar la propia solicitud responde
  `403 disclosure_self_decision`.
- **Solo quien pidió libera**: otro socio recibe `403 disclosure_not_requester`, comprobado antes que
  el estado para no revelar si la solicitud ajena está aprobada.
- **Quién decidió sale de la autenticación**: la fila guarda `decidedByPartnerId` y `decidedByActor`
  (cabecera `X-Partner-Actor`), expuestos como `decidedByPartnerKey` y `decidedByActor`. `decidedBy`
  del cuerpo es opcional y declarativo.
- **La base de datos lo impone también**: la restricción `disclosure_requests_decider_is_not_requester`
  rechaza una fila decidida por su solicitante, aunque la escritura rodee el servicio.

**Frontera.** La separación es entre socios, no entre personas, y `X-Partner-Actor` no está firmado
(§7.19). El flujo completo para cumplimiento está en el manual, §25.

---

## 5. API de verificación

### 5.1 Autenticación de socios

Cada petición va firmada con HMAC-SHA256 sobre una cadena canónica con el método, la ruta con su
cadena de consulta, la marca temporal, el nonce y el SHA-256 del cuerpo en crudo. La ventana es
`PARTNER_SIGNATURE_WINDOW_SECONDS` (300 en el ejemplo) y el nonce se reclama en Redis con
`SET NX EX` por el doble de la ventana, así que cada firma es de un solo uso. Si Redis no está
disponible, la petición se rechaza. Los secretos de socio se guardan envueltos con
`PARTNER_SECRET_ENCRYPTION_KEY` y datos asociados que incluyen la clave del socio. Cabeceras y
ejemplo en el manual, §18.

### 5.2 Alcances

Catorce alcances, no jerárquicos; cada ruta exige uno, declarado en `x-required-scope`. Las dos
aperturas (`GET /v1/credentials/:commitment/opening` y
`GET /v1/assets/:assetId/jurisdictions/:countryCode/opening`) exigen `credentials:opening`, de solo
lectura, que `issuer:admin` no incluye. Una apertura no revela identidad, pero sí la posición de hoja
y la raíz con las que se construye una prueba; la plataforma que construye pruebas necesita ese
alcance. Perfiles en el manual, §5.

### 5.3 Verificación de pruebas

`POST /v1/verifications` comprueba la prueba criptográficamente y, además, lo mismo que el atestador
antes del emparejamiento: las seis señales dentro del campo, el periodo reclamable, la raíz de
credenciales vigente, el activo registrado, la raíz de jurisdicciones vigente y el nulificador sin
gastar, todo leído en un solo bloque (§6.3). No comprueba el anclaje, porque la petición no nombra
sujeto: una prueba válida aquí puede revertir en cadena con `AnchorMismatch` si se presenta para
otro.

Los siete motivos de rechazo están en `REJECTION_CODES`: `public_signal_out_of_field`,
`invalid_proof`, `credential_root_not_valid`, `country_root_not_valid`, `asset_not_registered`,
`epoch_end_not_claimable` y `nullifier_already_spent`. Si la clave de verificación
(`PROOF_VERIFICATION_KEY_PATH`) no se puede leer, la respuesta es `verification_key_unavailable`: no
hay veredicto.

### 5.4 Frontera del esquema de prueba

La forma de una prueba se conoce en un solo módulo:

```
src/lib/proof-codec.ts                    cómo se escribe, se lee y se valida una prueba
src/services/proof-verification.service.ts  qué significa el veredicto y qué más se comprueba
rutas, registro de accesos, cumplimiento  no conocen el esquema
```

`PROOF_SCHEME` elige el esquema y debe coincidir con el adaptador montado en el atestador (§7.13).
`exportSolidityCallData` intercambia las coordenadas de cada elemento Fp2 de `B` en Groth16;
`groth16CallDataToProof` deshace el intercambio antes de verificar. PLONK no tiene compromisos sobre
Fp2 y sus 24 palabras se leen tal cual. Dos rechazos protegen la frontera:
`proof_scheme_mismatch` (una prueba del esquema que este despliegue no verifica) y
`verification_key_scheme_mismatch` (una clave de verificación del otro esquema).

### 5.5 Estado de cumplimiento y de credencial

`GET /v1/compliance/assets/:assetId/subjects/:subject` devuelve si la dirección tiene atestación viva
sobre el activo, hasta cuándo, y la retícula de periodos; ni identidad, ni jurisdicción, ni
caducidad de la credencial, ni compromiso. `GET /v1/credentials/:commitment` devuelve el estado de la
credencial; la caducidad se resuelve como hecho sobre una fecha, sin que ningún proceso tenga que
escribirla, e `inRegistry` indica si todavía se pueden producir pruebas.

### 5.6 Registro de accesos

- **Solo anexado**: disparadores de PostgreSQL rechazan `UPDATE`, `DELETE` y `TRUNCATE` sobre
  `access_log_entries`.
- **Cadena de hash con clave**: `entryHash = HMAC(ACCESS_LOG_HMAC_KEY, previousHash || entrada
  canónica)`. Reescribir la historia exige además la clave, y un `INSERT` directo en la tabla rompe
  la cadena.
- **Encadenado sin bifurcaciones**: secuencia y predecesor se leen bajo *advisory lock* en la misma
  transacción que el `INSERT`. Un único escritor por proceso anexa en lotes y reintenta.

Se registra toda petición a `/v1`, concedida o rechazada, incluidas las que no llegan a una ruta
(firma mala, ventana vencida, ruta inexistente) y las que el cliente corta (`outcome: aborted`,
estado 499), después de responder. Las rutas públicas de salud y especificación no se registran.
`GET /v1/access-log/integrity` recorre la cadena por páginas y nombra la primera entrada que no
verifica.

### 5.7 Especificación OpenAPI

`openapi.yaml` (OpenAPI 3.1) cubre las 25 operaciones del servicio (22 de `/v1`, `/health` y las dos
de la especificación), con esquemas de petición y respuesta, la autenticación de socio como cuatro
esquemas de seguridad exigidos juntos, `x-required-scope` en cada operación y el catálogo
`x-error-catalog` con los 55 códigos de error y su estado HTTP. Se sirve sin autenticación en
`/api/openapi.yaml`, desde disco, y en `/api/docs` con Scalar, cuyo renderizador se carga desde un
CDN fijado a su versión mayor; sin salida a internet se pierde solo la presentación.

`test/openapi.test.ts` recorre el router de Express y falla si una ruta no está documentada o no se
sirve, si un alcance difiere del de la ruta, si el catálogo y las llamadas a `apiError` divergen en
código o estado, si cambian `SCOPES`, `REJECTION_CODES` o `DISCLOSURE_SCOPES`, o si el documento deja
de ser OpenAPI 3.1 válido. No valida las respuestas contra sus esquemas (§7.12).

---

## 6. Relación con la cadena

### 6.1 Transporte JSON-RPC

`retryingTransport` reintenta cada petición ante HTTP 408, 425, 429 y 5xx, el código JSON-RPC 429 o
un mensaje de capacidad excedida, tiempos agotados, conexiones caídas y un nodo que aún no tiene el
bloque pedido. Espera `CHAIN_RPC_RETRY_BASE_MS` duplicado en cada intento, respeta `Retry-After`
hasta 30 s y se detiene en `CHAIN_RPC_MAX_RETRIES`; cada petición tiene un límite de
`CHAIN_RPC_TIMEOUT_MS`. Un *revert* nunca se reintenta. El reintento propio de viem está desactivado.

Los *reverts* se decodifican: `root_publication_reverted` y `root_invalidation_reverted` llevan en
`details.revert` el error del registro (`RootUnchanged`, `RootIsCurrent`, `UnknownRoot`…). Los
errores devuelven solo el mensaje corto, nunca la URL del proveedor.

### 6.2 Envíos y recibos

- **Nonces propios y monótonos**: el mayor entre el pendiente que informa el nodo y el siguiente no
  usado por el proceso; un envío fallido devuelve su nonce. Toma de nonce y entrega al nodo van de
  una en una; la espera de recibos es concurrente.
- **Reenvíos**: un «already known» es la transacción enviada; ante un «nonce too low» se consulta el
  hash y, si el nodo la tiene, también.
- **Recibos**: `CHAIN_CONFIRMATIONS` (1 en local, 2 en Base Sepolia), `CHAIN_RECEIPT_TIMEOUT_MS` y
  `CHAIN_POLLING_INTERVAL_MS`. Sin recibo a tiempo, la respuesta es `chain_receipt_timeout` con el
  hash, y se reconcilia antes de volver a escribir. Al esperar no se comprueban reemplazos: solo este
  proceso firma con la clave del emisor (§7.16).

### 6.3 Lecturas coherentes

Todas las lecturas de una respuesta (verificación, vigencia, cumplimiento, reconstrucción) se hacen
en un solo bloque: la cabeza del nodo, o el último bloque en que el proceso vio confirmada una
transacción propia si el nodo va por detrás. Un nodo sin ese bloque responde con un error que se
reintenta, nunca con el estado anterior. El gas de una invalidación se estima en ese mismo bloque.

La raíz sustituida se toma del evento `CredentialRootPublished` del propio recibo, no de una lectura
previa, y se compara con la última anotada en `root_publications`; una diferencia queda en el log
como divergencia que reconciliar. El suelo de lectura vive en el proceso (§7.17).

### 6.4 Reconstrucción y reconciliación

`CredentialLeafUpdated` y `CountryLeafUpdated` llevan índice, valor y si la hoja se insertó o se
quitó. Reproducidos en orden de bloque y de índice de log reconstruyen el árbol, cuya raíz se compara
con la del registro en el mismo bloque (`throughBlock`). Los eventos se leen en ventanas de
`CHAIN_LOG_BLOCK_RANGE` bloques (2 000 por defecto); si el nodo rechaza el rango, la ventana se parte
a la mitad hasta un bloque y se conserva la menor.

La reconciliación compara además cada árbol de jurisdicciones con la base de datos
(`missingFromDatabase`, `missingFromChain`) y lista los cierres pendientes
(`pendingRootInvalidations`). `npm run issuer:rebuild` termina con código distinto de cero ante
cualquier discrepancia e imprime `problems`. Detecta, no repara (§7.9). La cadena no contiene los
sobres de identidad: perder la base de datos deja divulgaciones inatendibles (§7.7). Uso y lectura
del resultado en el manual, §10.

### 6.5 ABI del servicio

El ABI del atestador que usa el servicio es de solo lectura y no incluye `attest` ni `attestFor`: el
servicio no presenta pruebas, lo hace la plataforma. `attestationOf` refleja igual la atestación
escrita por cualquiera de las dos entradas.

---

## 7. Riesgos abiertos

Límites conocidos del producto, por orden de importancia, con su condición de disparo.

### 7.1 Pérdida de la billetera y de la copia del secreto

Nadie puede reconstruir el secreto del inversor (§2.5). Con la copia cifrada, el riesgo se reduce a
perder a la vez billetera y copia; entonces la vuelta es revocar y reemitir tras una verificación
renovada, con intervención humana por incidente.

### 7.2 Aplicación cliente sin copia cifrada

La firma no es reproducible en general (§2.3) y el servicio no puede saber si detrás de un
`secretHash` hay una copia. **Disparo:** si la aplicación del inversor se entrega sin la copia de
§2.4, este riesgo pasa a ser el primero.

### 7.3 Dos billeteras para la misma persona

La unicidad de `secretHash` no detecta dos billeteras con dos identificadores de KYC; depende de la
deduplicación del proveedor de KYC. **Disparo:** si el proveedor no garantiza un identificador
estable por persona, hay que cerrarlo antes de producción.

### 7.4 Emisión indebida por el emisor

El emisor no puede suplantar a un inversor existente, pero sí fabricar una credencial con un secreto
propio. Deja rastro en el registro de emisiones y en la cadena.

### 7.5 Custodio único de las claves de visualización

Quien tenga `DISCLOSURE_VIEWING_KEYS` abre cualquier identidad fuera del flujo, sin pasar por el
registro de accesos. **Disparo:** si el modelo de amenaza incluye a un operador con acceso al gestor
de secretos, esquema de umbral.

### 7.6 No repudio por HMAC

Suficiente para auditoría interna, no oponible frente a terceros (§4.4). **Disparo:** si una
solicitud debe sostenerse ante un tercero, firma asimétrica del socio con la pública registrada.

### 7.7 Pérdida de la base de datos

La cadena reconstruye los árboles, no los sobres (§6.4). La copia de seguridad de la base de datos,
con su política de retención, es obligatoria (manual, §13).

### 7.8 Emisión serializada

La publicación sostiene el *advisory lock* mientras espera el recibo y sus confirmaciones, y el
emisor admite del orden de una activación cada 2 s con 1 000 hojas (informe de seguridad y estrés).
**Disparo:** con picos mayores, publicación por lotes con cola, decidiendo qué se le comunica al
inversor entre emitir y publicar.

### 7.9 La reconciliación detecta, no repara

Repetir una operación a medias la completa (§3.5), pero las discrepancias de origen externo (copia
restaurada, reorganización profunda, cambio hecho fuera del servicio) no tienen reparación en la API:
decidir cuál de las dos fuentes es correcta es una decisión operativa (manual, §14.3).

### 7.10 Rotación de `SUBJECT_REFERENCE_KEY`

Las referencias escritas no se pueden recalcular sin los identificadores de KYC, que no se guardan:
rotar la clave exige que el banco vuelva a enviarlos, o el control de duplicados queda ciego hacia
atrás.

### 7.11 Sin límite de peticiones

La firma y el nonce impiden la repetición, no el volumen, y la cola de escrituras solo protege los
cambios de árbol. **Disparo:** antes de exponer el servicio fuera de una red controlada, límite por
socio y ruta.

### 7.12 Respuestas no validadas contra la especificación

Rutas, alcances y errores no pueden divergir del documento (§5.7); los esquemas de respuesta sí.
**Disparo:** en cuanto un integrador genere cliente desde `openapi.yaml`, validar cada respuesta de la
suite contra su esquema.

### 7.13 Esquema del servicio y del atestador

`PROOF_SCHEME` y el adaptador montado son independientes; si divergen, el servicio y la cadena dan
veredictos distintos. **Disparo:** antes de producción, leer `attestor.verifier().scheme()` al
arrancar y negarse a servir si no coincide.

### 7.14 Ceremonia local

Las claves de los dos esquemas salen de *powers of tau* generados con `scripts/setup.sh`. **Disparo:**
antes de producción, ceremonia de configuración de confianza con participantes independientes.

### 7.15 Cobertura por pruebas, no por demostración

La suite (§8) sustituye la cadena por dobles del registro, del atestador y de un nodo JSON-RPC
degradado, que no modelan la caducidad por tiempo de las raíces ni el avance del periodo; el ciclo
contra Base Sepolia cubre la cadena real. No sustituye a una auditoría externa. **Disparo:** antes de
producción.

### 7.16 Un solo proceso firma con la clave del emisor

Los nonces viven en memoria; dos instancias con la misma `ISSUER_PRIVATE_KEY` chocarían. **Disparo:**
con más de una instancia, la escritura en cadena pasa a un único trabajador o a una cola.

### 7.17 Suelo de lectura en el proceso

Tras un reinicio, hasta la primera escritura, las lecturas vuelven a la cabeza del nodo. Afecta solo
a una lectura hecha justo tras un reinicio que siguió a una escritura; se acepta.

### 7.18 Reorganizaciones más profundas que `CHAIN_CONFIRMATIONS`

Dejarían la base de datos por delante de la cadena. La reconciliación lo detecta
(`missingFromChain`); no se repara solo. **Disparo:** al operar en otra red, revisar las
confirmaciones.

### 7.19 Separación entre socios, no entre personas

Una persona con credenciales de dos socios puede pedir con uno y aprobar con otro (§4.5).
**Disparo:** si el modelo de amenaza lo incluye, la identidad del actor entra en la firma y se valida
contra un directorio.

### 7.20 Coste de construir el árbol

El árbol se construye desde las filas en cada cambio y en cada apertura, unos 2 ms por hoja, y el
cálculo bloquea el proceso (informe de seguridad y estrés). **Disparo:** pasadas unas pocas miles de
credenciales o con aperturas frecuentes, construir por niveles, con unas 20 veces menos llamadas a
Poseidon, y mantener el árbol en memoria.

---

## 8. Cobertura de pruebas

`npm test` ejecuta 291 pruebas en 17 archivos de `test/` sobre PostgreSQL y Redis reales, con
pruebas Groth16 y PLONK generadas por el circuito compilado; los resultados están en
`docs/evidencias/INDICE.md`. Cada sección de este documento tiene su archivo: secreto del titular
(`holder-secret`, `credential-material`), árboles (`merkle`), emisión (`issuance-flow`,
`operator-paths`, `write-capacity`), divulgación (`disclosure-encryption`, `disclosure-flow`),
autenticación (`partner-auth`), registro de accesos (`access-log`), verificación (`proof-verification`,
`proof-scheme`), especificación (`openapi`), cadena (`chain-rpc`, `chain-consistency`,
`chain-divergence`) y configuración (`config-file`).
