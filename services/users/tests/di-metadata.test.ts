import { describe, expect, it } from "vitest";
import { Injectable, Module } from "@nestjs/common";
import { CommandBus, CommandHandler, CqrsModule, type ICommandHandler } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";

// CONTRACT: This test is the toolchain's canary, not a feature test. esbuild (tsx
// and vitest) does NOT emit `design:paramtypes`, so type-based Nest DI silently
// injects `undefined` while `pnpm build` (tsc) works. It fails the moment the SWC
// plugin or .swcrc stops emitting decorator metadata. See [[dependency-injection]]
@Injectable()
class Probe {
  value(): string {
    return "resolved";
  }
}

class ProbeCommand {}

@CommandHandler(ProbeCommand)
class ProbeHandler implements ICommandHandler<ProbeCommand> {
  constructor(private readonly probe: Probe) {}
  async execute(): Promise<string> {
    return this.probe.value();
  }
}

@Module({ imports: [CqrsModule], providers: [Probe, ProbeHandler] })
class ProbeModule {}

describe("decorator metadata under the test toolchain", () => {
  it("emits design:paramtypes so Nest injects by type", () => {
    expect(Reflect.getMetadata("design:paramtypes", ProbeHandler)).toEqual([Probe]);
  });

  it("resolves a type-injected dependency through the CommandBus", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await moduleRef.init();
    expect(await moduleRef.get(CommandBus).execute(new ProbeCommand())).toBe("resolved");
    await moduleRef.close();
  });
});
