#!/usr/bin/env bash
# Generates the proving and verifying keys for both schemes over the same circuit,
# so that the comparison measures the scheme and not the circuit.
#
# The powers of tau used here are generated locally: enough to measure, never for
# production. A production deployment uses a public ceremony plus its own phase 2.
set -euo pipefail
cd "$(dirname "$0")/.."
B=build
P=15   # 2^15 = 32768, above the circuit's constraint count

npx --no-install snarkjs powersoftau new bn128 $P $B/pot_0.ptau -v > /dev/null
npx --no-install snarkjs powersoftau contribute $B/pot_0.ptau $B/pot_1.ptau --name="benchmark" -v -e="$(head -c 32 /dev/urandom | base64)" > /dev/null
npx --no-install snarkjs powersoftau prepare phase2 $B/pot_1.ptau $B/pot_final.ptau -v > /dev/null
echo "· powers of tau listos (2^$P)"

npx --no-install snarkjs groth16 setup $B/compliance.r1cs $B/pot_final.ptau $B/groth16_0.zkey > /dev/null
npx --no-install snarkjs zkey contribute $B/groth16_0.zkey $B/groth16.zkey --name="benchmark" -e="$(head -c 32 /dev/urandom | base64)" > /dev/null
npx --no-install snarkjs zkey export verificationkey $B/groth16.zkey $B/groth16.vkey.json > /dev/null
npx --no-install snarkjs zkey export solidityverifier $B/groth16.zkey $B/Groth16Verifier.sol > /dev/null
echo "· groth16 listo"

npx --no-install snarkjs plonk setup $B/compliance.r1cs $B/pot_final.ptau $B/plonk.zkey > /dev/null
npx --no-install snarkjs zkey export verificationkey $B/plonk.zkey $B/plonk.vkey.json > /dev/null
npx --no-install snarkjs zkey export solidityverifier $B/plonk.zkey $B/PlonkVerifier.sol > /dev/null
echo "· plonk listo"
