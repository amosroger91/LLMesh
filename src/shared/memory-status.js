// Only explicit memory diagnostics qualify; timeouts and generic errors do not.
export function memoryFailure(message){
  return /out of memory|not enough (?:free )?memory|insufficient (?:free )?(?:memory|ram|vram)|no model fits current budgets|memory allocation failed|failed to allocate.*(?:memory|buffer)/i.test(String(message??''));
}
