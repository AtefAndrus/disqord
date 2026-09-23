import { describe, expect, test } from "bun:test";
import { MODEL_COLOR_PALETTE } from "../../../src/types/embed";
import { getColorForModel } from "../../../src/utils/embedBuilder";

describe("getColorForModel", () => {
  test("同じモデルIDに常に同じパレット色を返す", () => {
    expect(getColorForModel("provider/model-id")).toBe(getColorForModel("provider/model-id"));
  });

  test("モデルIDに対応するパレット色を返す", () => {
    const palette: number[] = [...MODEL_COLOR_PALETTE];
    expect(palette).toContain(getColorForModel("provider/model-id"));
  });
});
