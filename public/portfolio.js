// Preserve existing modules and remove unavailable actions from the portfolio UI.
for (const id of ['oddsProvider', 'footyProvider', 'builderFixtureId', 'builderQuote', 'builderFetchQuotes']) {
  const element = document.getElementById(id);
  if (element) (element.closest('.field') || element).hidden = true;
}
for (const element of document.querySelectorAll('[data-scanner-tab]')) {
  const visible = element.dataset.scannerTab === 'surebet';
  element.hidden = !visible;
  element.classList.toggle('active', visible);
}
document.getElementById('markets').hidden = false;
document.getElementById('opportunityMarkets').hidden = true;
document.getElementById('allOddsMarkets').hidden = true;
