/**
 * Drags a Playwright locator by (dx, dy) pixels with raw mouse events.
 * Apps with custom drag handlers (mousedown/move/up or pointer events:
 * editors, sliders, resize handles, sortable lists) ignore `.dragTo()`,
 * which dispatches HTML5 drag-and-drop events instead.
 */
export async function dragBy(page, locator, dx, dy, { steps = 12 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag target is not visible.");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
  }
  await page.mouse.up();
}
