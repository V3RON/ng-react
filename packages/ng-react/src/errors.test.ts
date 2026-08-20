import { describe, expect, it } from 'vitest';
import {
  DeadContextError,
  DependencyCycleError,
  DuplicateModuleIdError,
  InvalidDescriptorError,
  KernelError,
  ReservedModuleIdError,
  UnknownModuleError,
} from './errors';

describe('errors', () => {
  it('KernelError: carries a stable code, name, and optional moduleId', () => {
    const error = new KernelError('KERNEL_TEST', 'boom', { moduleId: 'orders' });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('KERNEL_TEST');
    expect(error.message).toBe('boom');
    expect(error.moduleId).toBe('orders');
  });

  it('F3: KernelError supports Error.cause for cause chains', () => {
    const cause = new Error('root cause');
    const error = new KernelError('KERNEL_TEST', 'boom', { cause });
    expect(error.cause).toBe(cause);
  });

  it('KernelError: leaves moduleId undefined when not supplied', () => {
    const error = new KernelError('KERNEL_TEST', 'boom');
    expect(error.moduleId).toBeUndefined();
  });

  it('ADR-2: ReservedModuleIdError carries the reserved-id code and the offending id', () => {
    const error = new ReservedModuleIdError('app');
    expect(error).toBeInstanceOf(KernelError);
    expect(error.name).toBe('ReservedModuleIdError');
    expect(error.code).toBe('KERNEL_RESERVED_MODULE_ID');
    expect(error.moduleId).toBe('app');
    expect(error.message).toContain("'app'");
  });

  it('M3: DuplicateModuleIdError names both sources', () => {
    const error = new DuplicateModuleIdError('orders', '@app/orders', '@app/orders-legacy');
    expect(error).toBeInstanceOf(KernelError);
    expect(error.name).toBe('DuplicateModuleIdError');
    expect(error.code).toBe('KERNEL_DUPLICATE_MODULE_ID');
    expect(error.moduleId).toBe('orders');
    expect(error.message).toContain('@app/orders');
    expect(error.message).toContain('@app/orders-legacy');
    expect(error.message).toContain("'orders'");
  });

  it('G1: DependencyCycleError reproduces the spec message verbatim', () => {
    const error = new DependencyCycleError(['orders', 'payments', 'risk']);
    expect(error).toBeInstanceOf(KernelError);
    expect(error.name).toBe('DependencyCycleError');
    expect(error.code).toBe('KERNEL_DEPENDENCY_CYCLE');
    expect(error.message).toBe(
      'Module dependency cycle: orders → payments → risk → orders. Break it by moving the shared surface into a contract.',
    );
  });

  it('G1: DependencyCycleError exposes the cycle path', () => {
    const error = new DependencyCycleError(['a', 'b']);
    expect(error.cycle).toEqual(['a', 'b']);
  });

  it('G1: DependencyCycleError rejects an empty cycle path', () => {
    expect(() => new DependencyCycleError([])).toThrow();
  });

  it('G2: UnknownModuleError names the missing module and the dependent', () => {
    const error = new UnknownModuleError('payments', 'orders');
    expect(error).toBeInstanceOf(KernelError);
    expect(error.name).toBe('UnknownModuleError');
    expect(error.code).toBe('KERNEL_UNKNOWN_MODULE');
    expect(error.moduleId).toBe('orders');
    expect(error.message).toContain("'payments'");
    expect(error.message).toContain("'orders'");
  });

  it('D1-D4: InvalidDescriptorError carries the given reason and optional moduleId', () => {
    const error = new InvalidDescriptorError('id must be a string', 'orders');
    expect(error).toBeInstanceOf(KernelError);
    expect(error.name).toBe('InvalidDescriptorError');
    expect(error.code).toBe('KERNEL_INVALID_DESCRIPTOR');
    expect(error.message).toBe('id must be a string');
    expect(error.moduleId).toBe('orders');
  });

  it('L4: DeadContextError names the module and mentions stale closures across HMR', () => {
    const error = new DeadContextError('orders');
    expect(error).toBeInstanceOf(KernelError);
    expect(error.name).toBe('DeadContextError');
    expect(error.code).toBe('KERNEL_DEAD_CONTEXT');
    expect(error.moduleId).toBe('orders');
    expect(error.message).toContain('orders');
    expect(error.message).toContain('HMR');
  });
});
