# Notas técnicas del circuito

Especificación del circuito de cumplimiento (`circuits/compliance.circom`) y de las comprobaciones
que `ComplianceAttestor` aplica sobre sus señales públicas: diseño implementado, supuestos a cargo
del contrato, garantías con sus fronteras y riesgos abiertos con su condición de disparo. El
servicio de emisión y divulgación se especifica en `../zk-api/NOTAS-API.md` (en adelante, NA).

## Índice

1. Señales y predicados: 1.1 Señales públicas · 1.2 Señales privadas · 1.3 Predicados ·
   1.4 Compromiso sobre el hash del secreto · 1.5 Caducidad frente al periodo · 1.6 Nulificador
2. Solidez del sistema de restricciones: 2.1 Rangos · 2.2 Separación de dominios ·
   2.3 Señales determinadas · 2.4 *Aliasing* de campo
3. Anclaje y presentación de la prueba: 3.1 Anclaje · 3.2 Las dos entradas del atestador ·
   3.3 Garantías de la presentación por terceros · 3.4 Guía para quien presenta
4. Supuestos a cargo del contrato: 4.1 Comprobaciones del atestador · 4.2 Unicidad del
   identificador de activo · 4.3 Frontera del verificador
5. Periodo de atestación: 5.1 Longitud de época · 5.2 Latencia de revocación ·
   5.3 Cambio de la longitud
6. Coste y capacidad
7. Riesgos abiertos: 7.1 a 7.9
8. Verificación

---

## 1. Señales y predicados

### 1.1 Señales públicas

Seis, en el orden de declaración, que es el orden en que `snarkjs` las escribe en el *calldata*:

| # | Señal | Quién fija su valor |
|---|---|---|
| 0 | `credentialRoot` | el contrato, desde el registro |
| 1 | `countryRoot` | el contrato, desde el registro, para el activo |
| 2 | `assetId` | el activo sobre el que se opera |
| 3 | `epochEnd` | el contrato, como frontera de periodo (§4.1) |
| 4 | `nullifier` | la prueba; el contrato comprueba que no esté gastado |
| 5 | `anchor` | el contrato, a partir del sujeto atestiguado (§3.1) |

### 1.2 Señales privadas

`secret`, `country`, `expiry` y las aperturas de Merkle (hermanos e índices de camino) del árbol de
credenciales y del árbol de jurisdicciones del activo.

### 1.3 Predicados

La plantilla se instancia como `Compliance(20, 8, 64, 16)`: 20 niveles en el árbol de
credenciales, 8 en el de jurisdicciones, 64 bits para marcas temporales y 16 para el código de
país. El circuito prueba que:

1. `Poseidon(Poseidon(secret), country, expiry)` es una hoja del árbol de raíz `credentialRoot`;
2. `expiry ≥ epochEnd`: la credencial sigue vigente cuando termina el periodo reclamado;
3. `country` es una hoja del árbol de raíz `countryRoot`;
4. `nullifier = Poseidon(secret, assetId, epochEnd)`.

Además, `anchor` forma parte del sistema de restricciones (§3.1). Ninguna señal pública revela
identidad, jurisdicción ni caducidad. Revocar es retirar el compromiso del registro: la credencial
deja de satisfacer el predicado 1 sin reemitir a nadie más.

### 1.4 Compromiso sobre el hash del secreto

El secreto lo genera y lo conserva el inversor. El emisor recibe solo `secretHash = Poseidon(secret)`
y construye la hoja `Poseidon(secretHash, country, expiry)`, con `country` y `expiry` tomados del
KYC. El nulificador deriva de `secret`, no de su hash: con lo que tiene, el emisor publica, comprueba
y revoca, pero no puede calcular un nulificador ni construir un testigo, y por tanto no puede probar
a nombre de ningún inversor.

**Frontera.** El circuito no sabe de dónde sale `secretHash`; eso se garantiza en la emisión con la
prueba de posesión de la billetera (NA §1.3). Ver §7.4.

### 1.5 Caducidad frente al periodo

El circuito no tiene un reloj fiable: compara `expiry` con `epochEnd`, que fija el contrato
(`GreaterEqThan(64)`, salida igual a 1). La atestación no puede sobrevivir a la credencial, y el
contrato escribe `expiresAt = epochEnd` sin conocer la caducidad. `expiry` es privada porque es la
misma constante en todos los activos del titular: publicada, enlazaría operaciones que el
nulificador por activo mantiene separadas, incluso si el inversor cambia de dirección.

### 1.6 Nulificador

Único por credencial, activo y periodo. Cada periodo la misma credencial produce un nulificador
nuevo, así que renovar no requiere al emisor, y en activos distintos los nulificadores no son
enlazables. `epochEnd` identifica el periodo; no hay una señal de época aparte.

---

## 2. Solidez del sistema de restricciones

Un fallo de solidez no rompe el camino feliz: lo que añade es la posibilidad de probar afirmaciones
falsas. Estas propiedades lo excluyen.

### 2.1 Rangos

`GreaterEqThan(n)` solo ordena correctamente operandos menores que `2^n`. Por eso:

- **`epochEnd`** va acotado a 64 bits. Sin la cota, `epochEnd = p - 1` hace que el comparador
  responda «vigente» para cualquier `expiry`.
- **`expiry`** va acotado a 64 bits: conserva la codificación que asume el resto del sistema y deja
  el invariante local, independiente de la anchura del comparador.
- **`country`** va acotado a 16 bits: cubre ISO 3166-1 numérico (10 bits) y separa los árboles
  (§2.2).

### 2.2 Separación de dominios

- **Entre árboles.** Las hojas de jurisdicción están en `[1, 2^16)`; una salida de Poseidon
  (compromiso o nodo interno) cae ahí con probabilidad ≈ 2⁻²³⁸. La cota de rango es la separación.
- **Hoja contra nodo interno.** En credenciales, la hoja es `Poseidon(3)` y los nodos `Poseidon(2)`,
  con permutaciones y constantes distintas; en jurisdicciones rige la cota anterior.
- **Profundidad.** Es constante; un nodo de nivel *k* no completa una apertura de longitud total.
- **Relleno.** El relleno a nivel de hoja vale `0`, y `country = 0` se excluye con
  `countryIsPadding.out === 0`.

Las hojas no llevan etiquetas de dominio explícitas (§7.2).

### 2.3 Señales determinadas

No hay señales subrestringidas. Las públicas las fija el contrato; `country` y `expiry` están
acotadas y ligadas al compromiso; `secret` y los hermanos de Merkle son libres por diseño y los
ligan el compromiso, el nulificador y la raíz. Los índices de camino están restringidos a bit
(`pathIndices[i] * (1 - pathIndices[i]) === 0`); sin ello, `MultiMux1`, lineal en el selector,
permitiría forjar el camino.

### 2.4 *Aliasing* de campo

Las entradas se reducen módulo `p`: `expiry + p` y `epochEnd + p` producen el mismo testigo, y `-1`
se lee como `p - 1` y lo rechaza el `Num2Bits` correspondiente. No hay descomposiciones de anchura
completa, así que no aparece el *aliasing* de `Num2Bits(254)`. En el contrato, el atestador exige
que las seis señales sean menores que `r` antes de usarlas (§4.1).

---

## 3. Anclaje y presentación de la prueba

### 3.1 Anclaje

Groth16 es maleable: atar la operación a los bytes de la prueba no protege nada. Lo que la ata es
que el sistema de restricciones dependa del sujeto. `anchor` es pública, el circuito no restringe su
valor (lo impone el contrato como `keccak256(abi.encode(subject, chainid, attestor)) mod r`) y la
obliga a figurar en el R1CS con `anchorSquared <== anchor * anchor`.

Una señal pública ausente de toda restricción recibe el punto identidad en la clave de verificación,
y el verificador ignora su valor aunque la señal conserve su índice y su valor en el testigo. Por
eso la suite comprueba que `main.anchor` sigue en `compliance.sym`, que aparece en A y en B de la
misma restricción del R1CS, y que la clave de verificación tiene `nPublic = 6` y siete puntos `IC`,
ninguno el punto identidad. De extremo a extremo, la misma prueba con el anclaje desplazado en 1 no
verifica.

### 3.2 Las dos entradas del atestador

- `attestFor(subject, proof, publicSignals)`: la llama cualquiera; rechaza la dirección cero, exige
  `anchor == anchorFor(subject)` y escribe la atestación a nombre de `subject`
  (`ComplianceAttested`). La usa la plataforma, que paga el gas.
- `attest(proof, publicSignals)`: equivale a `attestFor(msg.sender, …)`. Es la vía directa del
  titular si la plataforma no presenta su prueba.

Comparten camino y conjunto de nulificadores gastados. El titular no envía transacciones; solo
construye la prueba, porque sale de un secreto que solo él tiene.

### 3.3 Garantías de la presentación por terceros

1. **Una copia del *mempool* solo atestigua al sujeto del anclaje**; nombrar a otro exige el secreto.
2. **El nulificador es de un solo uso** por credencial, activo y periodo, para las dos entradas.
3. **La atestación no prueba que la dirección sea del titular**, sino que alguien con una credencial
   válida, vigente y admitida decidió atestiguarla a costa de su nulificador; recibirla sin pedirla
   no le quita nada al sujeto.
4. **No sustituye a la identidad verificada**: el sujeto tiene que estar además en el
   `IdentityRegistry` de ERC-3643 para recibir el token.
5. **Quien ordena las pruebas no acorta una atestación viva**: la prueba de un periodo anterior
   revierte con `AttestationWouldShorten` antes de gastar su nulificador (§4.1, punto 7).

### 3.4 Guía para quien presenta

- **`NullifierAlreadySpent`**: si `attestationOf(assetId, subject)` muestra ese nulificador, la misma
  prueba ya se presentó (por ejemplo, copiada del *mempool*) y la atestación está escrita. Es un
  éxito. La prueba no puede volver a presentarse.
- **`AttestationWouldShorten(current, claimed)`**: el sujeto ya está cubierto hasta `current`, más
  allá del periodo reclamado. No se gastó nada y no se reintenta.
- **`CredentialRootNotValid`** o **`CountryRootNotValid`**: la raíz ya no se acepta; hay que pedir
  aperturas nuevas y construir otra prueba.
- El resto (`AnchorMismatch`, `EpochEndNotCurrent`, `AssetNotRegistered`, `InvalidProof`,
  `PublicSignalOutOfField`) son rechazos de la prueba.

---

## 4. Supuestos a cargo del contrato

El circuito prueba predicados sobre señales públicas; que esas señales signifiquen algo depende del
verificador. Los puntos 1 a 8 de §4.1 están implementados en el camino común de `attest` y
`attestFor` y cubiertos por pruebas; los puntos 9 y 10 son supuestos que ningún contrato puede
imponer.

### 4.1 Comprobaciones del atestador

1. **Señales en el campo**: cada una menor que `r` (`PublicSignalOutOfField`), sea cual sea el
   verificador montado.
2. **Periodo reclamable**: con `currentEpochEnd = (block.timestamp / epochLength + 1) * epochLength`,
   `epochEnd` es `currentEpochEnd` o `currentEpochEnd + epochLength` (`EpochEndNotCurrent`). Sin
   esto, el probador elegiría la duración de su atestación.
3. **Anclaje del sujeto**: `anchor == uint256(keccak256(abi.encode(subject, block.chainid,
   address(this)))) % r` (`AnchorMismatch`). Ata la prueba a la persona, la cadena y el despliegue;
   quien envía la transacción no interviene.
4. **Raíces vigentes**: se validan contra el registro (`CredentialRootNotValid`,
   `AssetNotRegistered`, `CountryRootNotValid`). Una raíz sustituida sigue siendo válida durante
   `rootValidityWindow` (15 minutos por defecto, un día como máximo) salvo que se invalide; ese es el
   tiempo en que una revocación aún no surte efecto.
5. **Nulificador sin gastar** (`NullifierAlreadySpent`), marcado como gastado de forma atómica con
   la atestación.
6. **`assetId` del activo sobre el que se opera**, sin colisión entre *compliances* (§4.2).
7. **Sin acortar una atestación viva**: si la atestación existente caduca después del periodo
   reclamado, revierte con `AttestationWouldShorten` antes de gastar el nulificador. Una caducidad
   igual o menor se sobrescribe (renovación). `revokeAttestation` borra el registro.
8. **Prueba válida** para el adaptador montado (`InvalidProof`).
9. **Ceremonia**: `scripts/setup.sh` genera las claves localmente. Sirven para la red de pruebas, no
   para producción, que exige una ceremonia pública de *powers of tau* y otra propia del circuito.
10. **Confianza en el emisor**: el circuito prueba pertenencia al registro, no la veracidad de la
    credencial. Un emisor comprometido puede emitir credenciales indebidas y retirar la de
    cualquiera, pero no suplantar a un inversor existente, cuyo `secret` desconoce.

### 4.2 Unicidad del identificador de activo

`ZKComplianceModule` mantiene `assetIdOf` y `complianceOfAsset` uno a uno: un identificador ligado
no lo reclama otra *compliance* (`AssetIdAlreadyBound`) y el propietario recupera el de un
despliegue retirado con `releaseAssetId`.

**Frontera.** La reserva es por orden de llegada; adelantarse no da atestaciones ajenas y se deshace
con `releaseAssetId`. Entre dos despliegues del módulo con el mismo atestador, el `assetId` lo crea
quien publica su raíz de jurisdicciones bajo `JURISDICTION_ROLE`.

### 4.3 Frontera del verificador

`IProofVerifier` recibe la prueba como `bytes` opacos (256 bytes en Groth16, 768 en PLONK) y las seis
señales. Cada esquema tiene un adaptador que envuelve sin modificar el verificador que genera
snarkjs. El atestador guarda el verificador en una variable de estado (`setVerifier`): cambiar de
esquema conserva roles, nulificadores y atestaciones.

Los dos adaptadores aceptan y rechazan lo mismo. El verificador PLONK generado no comprueba que las
señales pertenezcan al campo, y admitiría una prueba para `nullifier + r`, que el contrato vería como
otro nulificador; `PlonkVerifierAdapter` hace la comprobación por su cuenta. La suite
(`test/verifier-boundary.test.ts`) lo demuestra con un verificador que acepta todo detrás, y recorre
la atestación con los dos esquemas sobre el mismo testigo con idéntico resultado. El esquema
desplegado es Groth16.

---

## 5. Periodo de atestación

### 5.1 Longitud de época

La atestación es un permiso vigente que `moduleCheck` consulta en cada transferencia; la longitud de
época fija a la vez la latencia de revocación automática y la cadencia de renovación. Por defecto,
**30 días** (también en Base Sepolia), entre 1 hora y 90 días, ajustable con `setEpochLength`.
Renovar exige que la aplicación del inversor construya una prueba contra las raíces vigentes; como se
admite el periodo siguiente, una renovación cubre hasta 60 días.

### 5.2 Latencia de revocación

```
latencia máxima = rootValidityWindow + 2 × epochLength = 15 min + 60 días (por defecto)
```

El primer término es el tiempo en que una raíz sustituida aún permite emitir atestaciones con una
credencial retirada; el segundo, lo que vive una atestación ya emitida. Es el respaldo para lo que
nadie corta a mano: `revokeAttestation` corta una atestación al instante e
`invalidateCredentialRoot` cierra la ventana de raíz (el servicio lo hace por defecto, NA §3.3).
Procedimiento en el manual de usuario y de operación, §7.2 y §7.4.

**Condición de disparo para acortarla.** La revocación dirigida exige conocer la dirección de la
credencial revocada. Un despliegue sin ese vínculo tiene la época como única palanca: hay que bajarla
a 7 días o dar al inversor una renovación asistida semanal.

### 5.3 Cambio de la longitud

Renumera las fronteras: las pruebas construidas contra las anteriores dejan de aceptarse y las
atestaciones emitidas conservan su `expiresAt`. No afecta a la seguridad, pero hay que anunciarlo.

---

## 6. Coste y capacidad

| Circuito | Valor |
|---|---|
| Restricciones no lineales | 7 843 (216 del `Poseidon(1)` del hash del secreto) |
| Restricciones lineales | 8 560 |
| Cables | 16 433 |
| Entradas públicas | 6 |

| Gas (red local) | Groth16 | PLONK |
|---|---|---|
| Verificación pura | 249 461 | 300 256 |
| `attest` | 344 521 | 399 148 |
| `attestFor` | 344 957 | 399 584 |
| Despliegue del verificador | 450 287 | 1 549 560 |

La atestación la paga quien la presenta. Las mediciones en red pública están en el informe de
seguridad y estrés.

**Capacidad.** 1 048 576 posiciones de credencial, que no se reutilizan (NA §3.3), y 256
jurisdicciones por activo (§7.7).

---

## 7. Riesgos abiertos

Límites conocidos del producto, por orden de importancia, con su condición de disparo.

### 7.1 Latencia de revocación

Hasta `rootValidityWindow + 2 × epochLength` (§5.2); por eso la revocación dirigida forma parte de la
operación. **Disparo:** cualquier aumento de esos parámetros, o un despliegue sin vínculo entre
credencial y dirección.

### 7.2 Sin etiquetas de dominio en las hojas

La separación entre árboles descansa en la cota de 16 bits de `country` (§2.2). **Disparo:** ampliar
el espacio de códigos, admitir identificadores de jurisdicción no numéricos o añadir un tercer árbol
exige introducir antes etiquetas de dominio en el hash de la hoja.

### 7.3 Entropía del secreto

El nulificador tiene dos entradas públicas: un secreto de un espacio pequeño o predecible se enumera
y desanonimiza al inversor. El circuito no puede comprobarlo. La implementación de referencia
muestrea uniformemente en el campo (NA §2.1). **Disparo:** toda aplicación que implemente el lado del
inversor debe cumplir el mismo requisito (manual, §32).

### 7.4 Origen de `secretHash`

El circuito no prueba que el hash del compromiso corresponda a un secreto que solo el inversor
conoce; lo cierra la prueba de posesión en la emisión (NA §1.3). **Disparo:** una vía de emisión sin
esa firma reabre la suplantación por el emisor.

### 7.5 Enlazabilidad dentro del periodo

`(assetId, nullifier)` es estable durante un periodo: las operaciones del mismo inversor en el mismo
activo y periodo son enlazables. Entre periodos y activos no. Limita lo que se puede prometer sobre
privacidad.

### 7.6 Fuga por la renovación que no ocurre

Un inversor cuya credencial no alcanza el periodo siguiente no puede renovar por adelantado; renovar
tarde o no renovar es una señal de un bit observable en cadena. Documentada, no mitigada.

### 7.7 Capacidad fija

2^20 credenciales y 2^8 jurisdicciones por activo. **Disparo:** al acercarse al límite, recompilar
con más profundidad, repetir la ceremonia y desplegar el verificador nuevo.

### 7.8 Cobertura por pruebas, no por demostración

La suite (§8) no sustituye a una revisión formal ni a una auditoría externa del R1CS y de los
contratos. **Disparo:** antes de producción.

### 7.9 Verificador PLONK sin validación de campo propia

El control vive en el adaptador y en el atestador (§4.3). **Disparo:** al regenerar el verificador
PLONK o sustituir su adaptador, hay que conservar la comprobación en la frontera.

---

## 8. Verificación

`npm test` en `zk-circuits` compila el circuito y ejecuta 39 pruebas; `npx hardhat test` en
`zk-contracts` ejecuta 129. Los resultados están en `docs/evidencias/INDICE.md`.

El camino feliz se valida con `snarkjs.wtns.check` contra el `.r1cs`, y cada prueba de rechazo exige
que el error nombre la restricción que debe fallar (`test/helpers.mjs`).

La suite del circuito cubre el secreto del inversor, cada predicado por separado, el nulificador, el
anclaje (§3.1), aperturas forjadas, rangos (§2.1), separación de dominios (§2.2) y *aliasing*
(§2.4). La de los contratos cubre los puntos 1 a 8 de §4.1, la presentación por terceros (§3.3), la
unicidad de `assetId` y los dos esquemas.
