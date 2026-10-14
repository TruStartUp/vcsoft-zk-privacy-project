# La capa de confidencialidad sobre la tokenización, demostrada contra los contratos reales

Este documento explica, sin necesidad de leer el código, qué hace la suite
`zk-contracts/test/integration-erc3643.test.ts`, qué despliega, qué recorre y qué demuestra
cada una de sus aserciones.

La salida cruda de la corrida está en
[`2026-09-03_zk-contracts_integracion-erc3643.log`](2026-09-03_zk-contracts_integracion-erc3643.log):
**19 pruebas, todas en verde, 12 segundos**.

---

## 1. Qué se quería demostrar, y por qué no estaba demostrado

El acta afirma que la capa de privacidad **se monta sobre la tokenización sin reemplazarla**:
el motor de cumplimiento del estándar sigue decidiendo, sólo que ahora decide contra una
prueba en vez de contra un registro público de identidades.

Hasta ahora esa afirmación no estaba probada. Los contratos de la capa (el registro de
credenciales, el atestador y el módulo de cumplimiento) estaban cubiertos por 74 pruebas,
pero **en aislamiento**: el módulo se ejercía contra una `ModularCompliance` de mentira,
escrita para las pruebas, que no era el contrato del estándar y que no tenía detrás ni un
token, ni un registro de identidades, ni un emisor de reclamaciones. Una capa que funciona
contra un doble no ha demostrado que funcione sobre lo real.

Esta suite cierra ese hueco: despliega la suite T-REX de verdad y engancha el módulo a **su**
compliance.

---

## 2. Qué se despliega

### 2.1 La suite T-REX, del estándar

Todos los contratos ERC-3643 se despliegan desde el **bytecode que publica la organización
ERC-3643**, versión **4.1.3**, en el paquete `@erc3643org/erc-3643`. No hay ninguna
reimplementación, ningún simulacro y ninguna versión recortada: es el código que el estándar
distribuye.

El montaje sigue la forma canónica, con implementaciones detrás de una autoridad de
implementación y proxies apuntando a ella:

| Pieza | Qué es |
|---|---|
| `TREXImplementationAuthority` | Contrato de referencia que registra la versión 4.1.3 y sus seis implementaciones; todos los proxies le preguntan a él dónde está su lógica |
| `Token` (proxy) | El token del activo: *VCSoft Tokenized Asset* (`VCSA`), 18 decimales |
| `ModularCompliance` (proxy) | El motor de cumplimiento del token: mantiene la lista de módulos y consulta a todos en cada operación |
| `IdentityRegistry` (proxy) | Decide si una dirección está verificada, consultando reclamaciones en su ONCHAINID |
| `IdentityRegistryStorage` (proxy) | Almacén de identidades y países, ligado al registro anterior |
| `TrustedIssuersRegistry` (proxy) | Qué emisores de reclamaciones acepta el token |
| `ClaimTopicsRegistry` (proxy) | Qué temas de reclamación exige el token |
| `ClaimIssuer` (ONCHAINID) | El emisor de la reclamación de identidad verificada, con su clave de firma |
| `Identity` (ONCHAINID) | Una por inversor, con su billetera como clave de gestión |

Además se configura lo que hace falta para que el token funcione de verdad: el agente del
token y del registro de identidades, el tema de reclamación que el token exige
(`keccak256("VCSOFT_KYC_VERIFIED")`), el emisor de confianza autorizado para ese tema, y el
token despausado.

Cada inversor recibe su ONCHAINID con una reclamación **firmada de verdad** por la clave del
emisor de confianza, y queda registrado con su país. Es lo que hace que
`IdentityRegistry.isVerified` diga «sí» antes de que la capa de confidencialidad diga nada.

La primera prueba de la suite comprueba que esto es lo que parece: que el token declara la
versión `4.1.3`, que apunta al registro de identidades y a la compliance desplegados, que la
compliance está ligada al token, y que **los tres proxies principales apuntan a la autoridad
de implementación**. Una implementación desplegada suelta no pasaría esa comprobación.

### 2.2 La capa de confidencialidad

Encima de esa suite se despliegan los tres contratos de la capa y se enganchan:

| Pieza | Configuración |
|---|---|
| `CredentialRegistry` | Ventana de validez de raíz sustituida: 15 minutos |
| `Groth16Verifier` | El verificador generado por snarkjs a partir del circuito compilado |
| `ComplianceAttestor` | Longitud de época: 30 días |
| `ZKComplianceModule` | Desplegado detrás del `ModuleProxy` **del propio estándar**, e inicializado en la misma transacción |

El enganche son dos llamadas del estándar, no una API propia:

1. `ModularCompliance.addModule(módulo)`, el mismo camino por el que se añade cualquier
   módulo ERC-3643.
2. `ModularCompliance.callModuleFunction(setAssetId(3643), módulo)`: la compliance declara
   sobre qué activo opera. Es la propia compliance quien lo declara, no un tercero.

La segunda prueba comprueba el resultado: el módulo es el único módulo de la compliance, está
ligado a ella en los dos sentidos, tiene el activo `3643` asignado y apunta al atestador
desplegado.

### 2.3 Las primitivas criptográficas vienen de `zk-api`

Los árboles de Merkle y la permutación Poseidon **se importan de `zk-api`**
(`src/lib/merkle.ts`, `src/lib/poseidon.ts`, `src/lib/field.ts`), no se reescriben. Es
deliberado: el relleno de las posiciones vacías, el orden de los hermanos y la aridad del
hash son exactamente donde una segunda implementación se desvía de la primera sin que nada
avise, y una desviación ahí produciría una raíz que la cadena acepta y una apertura que el
circuito rechaza.

Lo único que sí se reconstruye en la prueba es el **dominio EIP-712 de activación**, por dos
razones concretas: `zk-api` lo lee de una configuración de servicio que exige base de datos,
Redis y un juego completo de claves, y el dominio nombra la dirección del `CredentialRegistry`,
que no se conoce hasta que este despliegue ocurre.

### 2.4 Los actores

| Titular | Jurisdicción | Situación de partida | Para qué está |
|---|---|---|---|
| Alicia | España (724), admitida | Credencial activa | Recorre el ciclo completo |
| Bruno | Francia (250), admitida | Credencial activa | Contraparte de la transferencia |
| Carmen | España (724), admitida | Credencial activa, **nunca presenta prueba** | El titular sin atestación |
| Darío | Estados Unidos (840), **no admitida** | Credencial activa | La jurisdicción que el activo no admite |
| Elena | España (724), admitida | Credencial activa, **sin identidad en el registro T-REX** | Demuestra que la capa añade una condición, no sustituye la del estándar |
| Fabio | España (724), admitida | Credencial **pendiente**, sin publicar | Permite recorrer los dos tiempos de la emisión |

Todos menos Elena están verificados por el estándar. El activo `3643` admite las
jurisdicciones {724, 250}.

---

## 3. El ciclo, paso a paso

### Paso 1. La emisión en dos tiempos no publica nada hasta que el titular aporta su hash

La mesa de emisión registra el veredicto del KYC de Fabio y ahí se detiene: la credencial
queda **pendiente**, sin compromiso, sin posición de hoja y sin nada publicado en cadena.

Después el titular hace su parte: calcula `Poseidon(secreto)` a partir de un secreto que sólo
él conoce, y lo entrega junto con una firma EIP-712 de posesión de su billetera. Sólo entonces
la mesa construye la hoja `Poseidon(hash del secreto, país, caducidad)`, le asigna posición y
publica la raíz nueva.

**Qué demuestra la aserción:** que la raíz de credenciales no cambia mientras la credencial
está pendiente; que cambia exactamente al activarla; que el compromiso publicado es el que
resulta del hash del secreto y no del secreto; y que la transacción emite un evento
`CredentialLeafUpdated` con ese compromiso, que es lo que permite reconstruir el árbol desde
la cadena. Comprueba además que la raíz anterior sigue siendo válida durante su ventana, que
es el comportamiento documentado y no un descuido.

### Paso 2. La activación exige la firma del titular, no la de la mesa

Se intenta activar la credencial de Fabio con la firma de otra billetera.

**Qué demuestra:** que la mesa rechaza la activación (`holder_possession_not_proven`) y que la
raíz publicada no se mueve. Sin esta comprobación, quien conociera el identificador de una
credencial pendiente podría registrar su propio hash y quedarse con la credencial de otra
persona; y el propio emisor podría sustituir el hash por uno suyo, que es exactamente la
capacidad que este diseño le quita.

### Paso 3. La raíz de jurisdicciones del activo está publicada

El responsable de jurisdicciones publica en el registro la raíz del árbol de países admitidos
por el activo `3643`.

**Qué demuestra:** que la raíz que el registro tiene es la del árbol que la prueba va a usar,
y que las dos hojas admitidas son España y Francia. Si estas dos no coincidieran, la prueba
del titular fallaría por una razón que no tiene nada que ver con el cumplimiento.

### Paso 4. El titular presenta su prueba y obtiene atestación; nadie puede presentarla por él

Alicia genera una **prueba Groth16 real** sobre el circuito compilado, contra las raíces que
el registro tiene en ese momento y anclada a su propia dirección. La presenta al
`ComplianceAttestor`.

**Qué demuestran las aserciones:**

- Que las seis señales públicas salen en el orden que el contrato lee: raíz de credenciales,
  raíz de países, activo, fin de periodo, nulificador y anclaje. Un cambio de orden en la
  herramienta que exporta el *calldata* rompería el sistema en silencio.
- Que **otra dirección no puede presentar esa misma prueba**: el intento falla con
  `AnchorMismatch`. Es lo que impide que alguien copie la prueba del *mempool* y la gaste. Y
  es también la razón por la que la plataforma no puede presentar la prueba en nombre del
  titular: la renovación exige la firma del inversor.
- Que la atestación queda emitida, viva, con caducidad igual al fin del periodo reclamado, y
  que el nulificador queda registrado como gastado.

### Paso 5. El token T-REX acuña al titular porque el módulo encuentra la atestación

Antes de la atestación, la compliance del token responde que **no** se puede entregar a
Alicia. Después de la atestación responde que **sí**, y el agente del token acuña 1 000 `VCSA`
a su favor.

**Qué demuestra:** que la decisión del token cambia por la atestación y por nada más. El
`mint` de ERC-3643 exige dos cosas: identidad verificada, que ya lo estaba antes, y
`compliance.canTransfer`, que sólo pasa a valer «sí» cuando el módulo encuentra la
atestación. El saldo y el suministro total quedan comprobados después.

### Paso 6. Una transferencia entre titulares atestados atraviesa el módulo y se completa

Alicia y Bruno obtienen atestación cada uno con su propia prueba; se acuña a Alicia y ella
transfiere 250 `VCSA` a Bruno.

**Qué demuestra:** que el camino de transferencia, y no sólo el de emisión, pasa por el módulo
y se completa. Los saldos de las dos partes quedan comprobados.

### Paso 7. Revocar la credencial cierra la emisión de atestaciones nuevas

La mesa revoca la credencial de Alicia: quita la hoja, publica la raíz sin ella e invalida la
raíz sustituida.

**Qué demuestran las aserciones:**

- Que la hoja ya no está en el árbol y que la raíz publicada es la nueva.
- Que la raíz anterior **deja de ser válida de inmediato**. Sin la invalidación seguiría
  siendo aceptable durante quince minutos, y contra ella la credencial revocada seguiría
  probando pertenencia.
- Que una prueba que Alicia hubiera construido antes de la revocación, para renovar el periodo
  siguiente, **es rechazada por el contrato** con `CredentialRootNotValid`, nombrando la raíz
  exacta que dejó de valer.
- Que una prueba nueva **ni siquiera se puede construir**: el circuito aborta, y aborta en la
  línea del predicado 1 («el compromiso está en el registro») y no en cualquier otra. La
  aserción localiza esa línea en el fuente del circuito y exige que el mensaje de error la
  nombre, para que un rechazo por el motivo equivocado no pase por bueno.

### Paso 8. Cortar la atestación viva bloquea la entrega, y el rechazo es del módulo

Revocar la credencial no mata la atestación que ya estaba emitida: eso es un hecho del diseño,
no un olvido, y la latencia está documentada. Cortarla de inmediato es
`ComplianceAttestor.revokeAttestation`, y eso es lo que hace la plataforma en este paso.

A partir de ahí, la transferencia de Bruno a Alicia se rechaza.

**Qué demuestra:** que el rechazo existe **y que es del módulo ZK**. Cómo se garantiza eso
está en la sección 5, porque es la parte más delicada de toda la suite.

---

## 4. El cumplimiento no se relaja

Cuatro casos que comprueban que añadir la capa no abre ninguna puerta, y uno que delimita
honestamente hasta dónde llega el módulo.

### Un titular sin atestación no recibe

Carmen tiene credencial activa y está verificada por el estándar, pero nunca ha presentado una
prueba. El `mint` a su favor se rechaza. Todas las reglas del estándar están satisfechas: el
único que dice que no es el módulo.

### Un titular cuya atestación caducó tampoco recibe

Alicia obtiene su atestación y se avanza el reloj. **Un segundo antes** del fin del periodo la
atestación sigue viva; **en el instante exacto** del fin deja de estarlo, y el `mint` se
rechaza. La frontera se comprueba por los dos lados, que es lo que distingue una comprobación
de caducidad de una comprobación de «hace mucho».

### Una jurisdicción no admitida no llega ni a obtener atestación

Darío está verificado por el estándar y su país registrado en el `IdentityRegistry` es 840;
el activo no lo admite. Intenta construir una prueba presentando la mejor apertura disponible
del árbol de jurisdicciones, y **el circuito la rechaza**, en la línea del predicado 3 («la
jurisdicción está admitida») y no en otra.

Este caso dice algo que conviene subrayar: **el estándar admitía a Darío**. Su identidad está
verificada y su país registrado; sin la capa, el token le habría entregado. La restricción de
jurisdicción por activo la aporta la capa de confidencialidad, y la aporta sin publicar el
país de nadie.

### Una atestación no sustituye a la identidad verificada del estándar

Elena obtiene una atestación válida y viva. La compliance dice que sí. Y el `mint` se rechaza
igualmente, con `Identity is not verified.`, porque no tiene ONCHAINID registrado.

La aserción va más allá: **quita el módulo ZK de la compliance y vuelve a intentarlo**, y el
rechazo es exactamente el mismo. Eso demuestra que la regla que la bloquea es del estándar y
seguiría bloqueando aunque la capa no existiera. Es la demostración directa de «se monta
encima sin reemplazarla».

### El módulo condiciona a quien recibe, no a quien envía

Alicia tiene saldo y se le corta la atestación. **Puede seguir transfiriendo** a un titular
atestado.

No es un fallo de la prueba: es lo que `moduleCheck` hace, porque sólo mira al receptor. Está
aquí como aserción explícita para que quede escrito y nadie lea de más en las secciones
anteriores. Un despliegue que necesite inmovilizar a un titular revocado tiene que usar el
congelado de billetera del propio ERC-3643, que es una capacidad del estándar y no de esta
capa.

---

## 5. Cómo se garantiza que el rechazo viene del módulo ZK

Es lo que más fácilmente convierte una suite verde en una suite que miente.

**El problema.** `Token.mint` revierte con `Compliance not followed` para cualquier módulo que
diga que no. `Token.transfer` revierte con `Transfer not possible` **tanto si falló la
verificación de identidad como si falló el cumplimiento**. Ninguno de los dos mensajes
identifica a quien rechazó. Una prueba que se limitara a esperar la reversión pasaría por el
motivo equivocado en cuanto empezara a bloquear otra regla (una billetera congelada, el token
en pausa, un saldo inmovilizado, un segundo módulo) y no avisaría de nada.

**Lo que se hace en su lugar.** Cada aserción de rechazo **atribuye** el rechazo en cuatro
tiempos:

1. **Se demuestra que ninguna otra regla podía estar bloqueando.** El receptor está verificado
   por el `IdentityRegistry`; el token no está en pausa; ni el emisor ni el receptor tienen la
   billetera congelada; el emisor no tiene saldo inmovilizado y tiene saldo suficiente; y el
   módulo ZK es **el único módulo** enganchado a la compliance.
2. **Se demuestra que el módulo es quien dice que no.** `moduleCheck` devuelve `false` y
   `canTransfer` devuelve `false`.
3. **Se ejecuta la operación** y se exige la reversión.
4. **Se quita el módulo de la compliance y se repite la misma operación**, que ahora tiene que
   completarse.

El cuarto paso es el decisivo. Si algo que no fuera el módulo hubiera estado bloqueando, la
repetición fallaría igual y la prueba se caería. Que la operación pase en cuanto el módulo
desaparece es la prueba de que era él, y sólo él, quien la impedía.

**Y se comprobó rompiendo el sistema a propósito.** Tres mutaciones, cada una con su log en
esta carpeta:

| Mutación | Resultado | Qué confirma |
|---|---|---|
| Desenganchar el módulo de la compliance justo después de engancharlo | 9 en verde, **10 en rojo** | La suite falla si el módulo se desengancha. Sólo sobreviven las pruebas que no dependen de él |
| `moduleCheck` devolviendo `true` sin consultar la atestación | 11 en verde, **8 en rojo** | La admisión depende de la atestación, no de que el módulo esté simplemente presente |
| Dejar a la titular sin atestación fuera del `IdentityRegistry` del estándar | 15 en verde, **4 en rojo** | El discriminador funciona: cuando quien bloquea es otra regla, la prueba se niega a atribuir el rechazo al módulo y falla con *«el estándar da por verificado al receptor»* |

La tercera es la importante para esta sección. La operación seguía siendo rechazada por el
token, y la prueba habría pasado si sólo hubiera mirado la reversión. La suite falló de todos
modos, porque el motivo ya no era el que afirmaba.

Un cuarto grupo de pruebas, bajo el epígrafe *la prueba no se engaña a sí misma*, deja esa
sensibilidad dentro de la propia suite en vez de depender de que alguien repita las
mutaciones: se comprueba que con el módulo desenganchado la operación que se afirma bloqueada
pasa, que con el módulo enganchado no pasa, y que apuntar el módulo a otro activo hace que
deje de reconocer una atestación que sí existe.

---

## 6. Coste en gas de las operaciones del ciclo

Medido sobre la cadena local, con el optimizador activado a 200 pasadas. Son las cifras que
imprime la propia corrida. La atestación varía unas pocas decenas de gas de una prueba a otra
según cuántos bytes cero traiga el *calldata* de esa prueba concreta; es ruido, no una
diferencia de comportamiento.

| Operación | Gas | Quién la paga |
|---|---|---|
| `ModularCompliance.addModule` | 137 708 | El operador, una vez por activo |
| `ModularCompliance.callModuleFunction(setAssetId)` | 97 839 | El operador, una vez por activo |
| `CredentialRegistry.publishCountryRoot` | 58 963 | El responsable de jurisdicciones, cada vez que cambia el conjunto admitido |
| `CredentialRegistry.publishCredentialRoot` (activación) | 59 672 | El emisor, una vez por credencial activada |
| `ComplianceAttestor.attest` | 336 598 | **El titular**, una vez por activo y periodo |
| `Token.mint` (con el módulo consultado) | 258 123 | El agente del token |
| `Token.transfer` (con el módulo consultado) | 246 350 | El titular que envía |
| `CredentialRegistry.publishCredentialRoot` (revocación) | 59 636 | El emisor |
| `CredentialRegistry.invalidateCredentialRoot` | 28 005 | El emisor |
| `ComplianceAttestor.revokeAttestation` | 29 484 | El gestor de atestaciones |

Lo que estas cifras dicen del coste operativo:

- **La atestación es la operación cara**, y es la única que se repite por titular y por
  periodo. Con la época por defecto de 30 días son 336 598 gas por titular, por activo y por
  mes. Los 249 461 gas de la verificación Groth16 en sí ya estaban medidos; el resto son las
  comprobaciones que el contrato hace antes del emparejamiento y la escritura de la atestación.
- **Consultar el cumplimiento no cuesta nada en cadena**: `moduleCheck` es una vista y la
  atestación ya está escrita, así que el titular opera cuantas veces quiera dentro del
  periodo. Lo que el módulo añade al `mint` y al `transfer` es una lectura de dos posiciones
  de almacenamiento.
- **Publicar una raíz es barato** (unos 59 000 gas) porque los árboles viven fuera de la
  cadena: lo que se escribe es una raíz y lo que se emite son los eventos que permiten
  reconstruirlos.
- **Revocar cuesta menos que emitir**: cerrar la ventana de una raíz sustituida son 28 005 gas
  y cortar una atestación viva 29 484. La revocación no debe ser la operación cara del
  sistema, y no lo es.

---

## 7. Qué no queda cubierto

Lo que esta suite **no** demuestra, dicho entero:

1. **`zk-api` no participa.** El flujo de emisión en dos tiempos se recorre con las mismas
   primitivas del servicio (el árbol y el hash son literalmente su código), pero el servicio
   HTTP, su base de datos, sus sobres de identidad cifrados y su registro de accesos quedan
   fuera. Una corrida de punta a punta con el servicio real hablando contra esta cadena no
   está hecha.
2. **Los contratos del estándar se despliegan desde el bytecode publicado, no recompilados
   aquí.** Es el artefacto oficial de la versión 4.1.3, pero recompilarlo en este repositorio
   exigiría añadir `@onchain-id/solidity` como dependencia, y no se hizo.
3. **No se usa `TREXFactory`.** El paquete publica el interfaz de la fábrica de ONCHAINID pero
   no su implementación, que la fábrica de T-REX necesita para crear la identidad del token.
   La suite se monta pieza a pieza con **los mismos proxies** que la fábrica desplegaría, pero
   el camino de la fábrica no está ejercido.
4. **Un solo activo y un solo token.** La colisión de identificadores de activo entre dos
   *compliance* distintas está cubierta en la suite unitaria del módulo, no aquí.
5. **Las reglas del estándar se comprueban desactivadas, no combinadas.** Se afirma que el
   token no está en pausa, que nadie está congelado y que no hay otro módulo, porque eso es lo
   que hace atribuible el rechazo. Lo que no se ejercita es el módulo ZK **junto a** otro
   módulo del estándar, ni junto a un congelado parcial.
6. **El módulo mira al receptor y no al emisor.** Documentado y con aserción propia (§4), pero
   es una limitación del diseño, no algo que la prueba resuelva.
7. **La latencia de revocación no se recorre entera.** Se demuestran las dos vías inmediatas
   (invalidar la raíz y cortar la atestación), pero no el camino automático, que es de hasta
   dos épocas (60 días con los valores por defecto) y que no se puede simular en una prueba
   sin avanzar el reloj esas dos épocas.
8. **La ceremonia de la clave de prueba sigue siendo local.** El `zkey` viene de unos *powers
   of tau* generados en esta máquina. Sirve para medir y para probar; no sirve para
   producción, donde quien tenga el residuo tóxico puede falsificar cualquier prueba Groth16.
9. **Sólo Groth16 en cadena.** El verificador PLONK está desplegado y medido en la suite de
   comparación, pero la integración con T-REX se recorre únicamente con Groth16.
10. **Cadena local.** Todo ocurre en la red de Hardhat en proceso. No hay despliegue en una
    red pública ni medición de latencia real de bloque.

---

## Actualización del 04/09/2026 · la frontera del verificador

Este documento describe la corrida del 03/09. Dos cosas cambiaron después y se anotan aquí en
vez de reescribirlo, para que el registro siga diciendo lo que decía.

- **El montaje tiene un contrato más.** `ComplianceAttestor` ya no recibe el `Groth16Verifier`
  que genera snarkjs, sino un `Groth16VerifierAdapter` que lo envuelve tras `IProofVerifier`.
  La integración despliega los dos y engancha el adaptador; el resto del montaje y las
  diecinueve pruebas son las mismas, y siguen en verde
  ([`2026-09-04_zk-contracts_integracion-erc3643.log`](2026-09-04_zk-contracts_integracion-erc3643.log)).
- **El punto 9 de los límites se queda corto por poco.** Sigue siendo cierto que la integración
  con T-REX se recorre únicamente con Groth16. Lo que ya no es cierto es que PLONK sólo esté
  medido: `zk-contracts/test/verifier-boundary.test.ts` recorre la **atestación completa** con el
  adaptador de PLONK, sobre el mismo testigo, y obtiene el mismo nulificador, el mismo periodo y
  el mismo evento. Lo que falta por recorrer bajo PLONK es el tramo ERC-3643 que hay por encima
  del atestador, y ese tramo no lee la prueba: consulta `isAttested`.

---

## Actualización del 13/10/2026 · la plataforma presenta la prueba

Este documento describe la corrida del 03/09 y la nota del 04/09. El 13/10 cambió **quién
presenta la prueba**, y se anota aquí en vez de reescribir lo anterior, para que el registro siga
diciendo lo que decía.

### Qué cambió

`ComplianceAttestor` tiene una entrada nueva, `attestFor(subject, proof, publicSignals)`: la llama
cualquiera, exige que el anclaje de la prueba sea `anchorFor(subject)` y escribe la atestación a
nombre de `subject`, con el mismo evento `ComplianceAttested`. `attest(proof, publicSignals)` se
conserva y es exactamente `attestFor(msg.sender, …)`: la vía directa del titular, si la plataforma
no presenta su prueba. El circuito, las seis señales públicas, las claves y las *fixtures* no
cambian. El análisis de por qué esto no abre un ataque está en `zk-circuits/NOTAS-CIRCUITO.md`
§3.3.

### Lo que deja de ser cierto en el paso 4

El paso 4 dice que otra dirección no puede presentar la prueba, que por eso la plataforma no puede
presentarla en nombre del titular y que la renovación exige la firma del inversor. Lo primero se
matiza y lo segundo deja de ser cierto:

- Otra dirección **sí** puede presentar la prueba, pero sólo para el titular que nombra su anclaje.
  Una prueba copiada del *mempool* no puede atestiguar a quien la copia, ni a nadie más que a ese
  titular, ni más de una vez.
- La plataforma presenta la prueba y paga el gas; el titular no envía ninguna transacción para
  obtener ni para renovar su atestación. Lo que sigue exigiendo al titular es **construir** la
  prueba, porque sale de un secreto que sólo él tiene.

### Qué recorre ahora la integración

**20 pruebas, todas en verde**, dentro de la corrida completa de `zk-contracts` (120/120,
[`2026-10-13_zk-contracts_suite-completa.log`](2026-10-13_zk-contracts_suite-completa.log)). Las
diecinueve anteriores siguen, con estos cambios:

- **El ciclo atestigua a través de la plataforma.** Una cuenta propia de la plataforma llama
  `attestFor` con la prueba que cada titular construyó. Así obtienen su atestación Alicia y Bruno
  en los pasos 5, 6 y 8 y en los casos de las secciones 4 y 5.
- **Paso 4, rehecho:** *el titular construye su prueba y la plataforma la presenta; anclada a otro
  no sirve*. Además del orden de las seis señales, comprueba que el anclaje es
  `anchorFor(Alicia)`; que un intruso que la envía por la vía directa recibe `AnchorMismatch`; que
  la plataforma presentándola **para Bruno** recibe `AnchorMismatch`; que presentándola para
  Alicia emite `ComplianceAttested` con Alicia como sujeto; que la transacción la firma la
  plataforma; que **el número de transacciones y el saldo de Alicia no se mueven**; que la
  plataforma no queda atestada; y que, gastado el nulificador, Alicia ya no puede reutilizarlo por
  la vía directa.
- **Paso 4 bis, nuevo:** *el titular conserva la vía directa si nadie presenta por él*. Bruno
  envía su propia prueba con `attest` y queda atestado.
- **Paso 7:** la renovación construida antes de la revocación la presenta ahora la plataforma, y
  el contrato la rechaza igual, con `CredentialRootNotValid` y la raíz exacta que dejó de valer.
- **Elena** obtiene su atestación porque la plataforma la presenta por ella, y el token sigue sin
  entregarle (`Identity is not verified.`), con el módulo y sin él. Es el caso que conviene tener a
  la vista con `attestFor`: una atestación presentada por un tercero no sustituye a la identidad
  verificada que exige el estándar.

La suite unitaria del atestador añade siete pruebas para la entrada nueva: la plataforma
presentando y renovando, el sujeto equivocado, la copia del *mempool*, el nulificador gastado por
una entrada y no reutilizable por la otra, las dos entradas dejando la misma atestación y la
dirección cero como sujeto. La frontera del verificador suma una más, que recorre `attestFor` bajo
Groth16 y bajo PLONK.

**Una atestación viva no se acorta.** Separar al que presenta del titular abría un efecto de
orden: con la prueba del periodo corriente y la del siguiente pendientes a la vez, un tercero podía
copiar la del siguiente, entrar antes y dejar que la del corriente la sobrescribiera, acortando la
atestación y quemando el nulificador del periodo siguiente. El atestador lo impide ahora: una
prueba cuyo periodo termina antes que la atestación viva del mismo titular y activo revierte con
`AttestationWouldShorten`, antes de gastar su nulificador. Cuatro pruebas unitarias más lo cubren:
la del corriente rechazada por las dos entradas con la del siguiente dentro, el reordenamiento
desde el *mempool*, la revocación que vuelve a admitirla, y que sólo vigila al mismo titular y al
mismo activo. El detalle y la guía para el backend que presenta están en
`zk-circuits/NOTAS-CIRCUITO.md` §3.3 y §3.4.

### La suite detecta que se rompa

| Mutación | Resultado | Qué confirma | Log |
|---|---|---|---|
| `attestFor` comprueba el anclaje contra `msg.sender` en vez de contra el sujeto | 99 en verde, **17 en rojo** | Que la plataforma presentando por el titular depende de que el anclaje se compare con el sujeto: caen las pruebas unitarias de `attestFor`, la de los dos esquemas, la medición de gas y todo el ciclo de integración que atestigua a través de la plataforma | [`2026-10-13_zk-contracts_mutacion-attestfor-ancla-al-remitente.log`](2026-10-13_zk-contracts_mutacion-attestfor-ancla-al-remitente.log) |
| `attestFor` sin comprobar el anclaje (`attest` intacto) | 112 en verde, **4 en rojo** | Que la comprobación existe y está cubierta en las tres capas: la unitaria del sujeto equivocado, la de la copia del *mempool*, la de los dos esquemas y el paso 4 de la integración | [`2026-10-13_zk-contracts_mutacion-attestfor-sin-anclaje.log`](2026-10-13_zk-contracts_mutacion-attestfor-sin-anclaje.log) |

| Sin la comprobación `AttestationWouldShorten` | 118 en verde, **2 en rojo** | Que la protección contra el reordenamiento está cubierta: caen la prueba de la del corriente con la del siguiente dentro y la del reordenamiento desde el *mempool* | [`2026-10-13_zk-contracts_mutacion-atestacion-acortable.log`](2026-10-13_zk-contracts_mutacion-atestacion-acortable.log) |

Las tres mutaciones se revirtieron después de cada corrida. Las dos primeras se corrieron antes de
añadir la comprobación `AttestationWouldShorten`, sobre una suite de 116 pruebas; la tercera, sobre
la de 120.

### Coste en gas, y quién lo paga

Sustituye a la tabla de la sección 6 en la columna que cambió. Cifras de la corrida completa del
13/10; la atestación sigue variando unas decenas de gas de una prueba a otra por los bytes cero del
*calldata*.

| Operación | Gas | Quién la paga |
|---|---|---|
| `ModularCompliance.addModule` | 137 708 | El operador, una vez por activo |
| `ModularCompliance.callModuleFunction(setAssetId)` | 97 839 | El operador, una vez por activo |
| `CredentialRegistry.publishCountryRoot` | 58 963 | El responsable de jurisdicciones, cada vez que cambia el conjunto admitido |
| `CredentialRegistry.publishCredentialRoot` (activación) | 59 672 | El emisor, una vez por credencial activada |
| `ComplianceAttestor.attestFor` | 344 993 | **La plataforma**, una vez por titular, activo y periodo |
| `ComplianceAttestor.attest` | 344 545 | El titular, sólo si usa la vía directa |
| `Token.mint` (con el módulo consultado) | 258 100 | El agente del token |
| `Token.transfer` (con el módulo consultado) | 246 327 | El titular que envía |
| `CredentialRegistry.publishCredentialRoot` (revocación) | 59 636 | El emisor |
| `CredentialRegistry.invalidateCredentialRoot` | 28 005 | El emisor |
| `ComplianceAttestor.revokeAttestation` | 29 484 → 29 456 | El gestor de atestaciones |

- **La operación cara cambió de manos, y apenas de precio.** Las 344 993 unidades de gas por
  titular, activo y mes las paga ahora la plataforma. Presentar por otro cuesta unas 440 más que
  presentar por uno mismo: la palabra de *calldata* del sujeto y la comprobación de que no es la
  dirección cero.
- **La vía directa subió unas 980** (de 343 565 a 344 545): unas 590 porque el atestador tiene una
  función pública más que despachar y las dos entradas comparten una llamada interna, y unas 400
  por leer la atestación vigente antes de escribirla, que es lo que impide acortarla. Las
  diferencias de una a tres decenas en `mint`, `transfer` y `revokeAttestation` son del despacho.

### Lo que sigue sin cubrir

- **La plataforma es una cuenta de la red local.** El repetidor real sería el backend de la
  plataforma, que queda fuera de este repositorio; `zk-api` no tiene ruta de presentación ni la
  necesita, porque sólo lee del atestador.
- **El backend que presenta** tiene que leer `NullifierAlreadySpent` como éxito cuando
  `attestationOf` ya muestra ese nulificador, y `AttestationWouldShorten` como «el titular ya está
  cubierto más allá»; la integración no lo ejerce porque no hay backend en este repositorio.
- El resto de la sección 7 sigue valiendo, incluido que todo ocurre en la cadena local.
