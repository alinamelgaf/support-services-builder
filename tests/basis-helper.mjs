export async function applyBasis(page, layer, accept = true) {
  await page.locator(`input[name="proposal-basis"][value="${layer}"]`).click();
  if (await page.locator("#basis-dialog").isVisible()) {
    await page.locator("#basis-dialog").getByRole("button", { name: accept ? "Применить" : "Отмена", exact: true }).click();
  }
}

export async function saveTemplate(page, accept = true) {
  if (!await page.locator("#save-template").count()) {
    page.once("dialog", (dialog) => { void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.locator("#save-defaults").click();
    return;
  }
  await page.locator("#save-template").click();
  if (await page.locator("#basis-dialog").isVisible()) {
    await page.locator("#basis-dialog").getByRole("button", { name: accept ? "Заменить шаблон" : "Отмена", exact: true }).click();
  }
}
