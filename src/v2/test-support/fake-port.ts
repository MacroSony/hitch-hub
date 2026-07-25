export class UnimplementedTestPortError extends Error {
  readonly portName: string;
  readonly memberName: string;

  constructor(portName: string, memberName: string) {
    super(`test port ${portName}.${memberName} is explicitly unimplemented`);
    this.name = "UnimplementedTestPortError";
    this.portName = portName;
    this.memberName = memberName;
  }
}

/**
 * Empty fake suitable for composition before a later task implements a port.
 * Every accessed method throws synchronously and explicitly; it never returns
 * a permissive default that could make an acceptance case pass accidentally.
 */
export function createUnimplementedTestPort<Port extends object>(
  portName: string,
): Port {
  if (portName.trim().length === 0) {
    throw new TypeError("test port name must not be empty");
  }

  return new Proxy(Object.create(null) as Port, {
    get(_target, property): unknown {
      if (property === Symbol.toStringTag) {
        return `UnimplementedTestPort(${portName})`;
      }
      const memberName = String(property);
      return (): never => {
        throw new UnimplementedTestPortError(portName, memberName);
      };
    },
  });
}
