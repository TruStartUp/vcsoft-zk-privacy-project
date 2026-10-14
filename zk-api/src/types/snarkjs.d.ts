declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export interface PlonkProof {
    A: string[];
    B: string[];
    C: string[];
    Z: string[];
    T1: string[];
    T2: string[];
    T3: string[];
    Wxi: string[];
    Wxiw: string[];
    eval_a: string;
    eval_b: string;
    eval_c: string;
    eval_s1: string;
    eval_s2: string;
    eval_zw: string;
    protocol: string;
    curve: string;
  }
  export const groth16: {
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
  export interface SnarkLogger {
    info(message: string): void;
    debug(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }
  export const plonk: {
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: PlonkProof,
      logger?: SnarkLogger,
    ): Promise<boolean>;
  };
}
