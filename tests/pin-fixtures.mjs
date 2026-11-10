// Populate messages saved by the former default-pinning UI without creating new pins.
export async function savedPins(page, agent, messages) {
  await page.waitForFunction(() => sessionStorage.getItem('oxroute.pinWindow'));
  await page.evaluate(async ({ agent, messages }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('oxroute.pinnedMessages', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(messages.map(message => ({ id: crypto.randomUUID(), diffs: [], ...message,
        files: (message.files ?? []).map(file => new File([file.text], file.name, { type: file.type }))
      })), `${sessionStorage.getItem('oxroute.pinWindow')}:${agent}`);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { agent, messages });
  await page.reload();
}
