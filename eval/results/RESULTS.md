# Evaluation results

Reference date 2026-11-01. Judge/extractor: `ollama/gemma4:26b-a4b-chat` via Bifrost. Live Tavily search, one query per claim.

| metric | value |
|---|---|
| claims | 25 |
| time-sensitivity flag accuracy | 25/25 (100.0%) |
| verdict accuracy (supported / changed / unverifiable) | 22/22 (100.0%) |
| stale ("changed") precision | 100.0% |
| stale ("changed") recall | 100.0% |
| stale F1 | 100.0% |
| verdicts downgraded for missing verbatim evidence | 0 |
| Tavily searches | 22 |
| LLM calls through Bifrost (fallback-served) | 47 (0) |

Confusion matrix (rows = expected, columns = predicted):

| expected \ predicted | supported | changed | unverifiable | none |
|---|---|---|---|---|
| supported | 6 | 0 | 0 | 0 |
| changed | 0 | 13 | 0 | 0 |
| unverifiable | 0 | 0 | 3 | 0 |

| id | claim | sensitive (pred/exp) | verdict (pred/exp) | freshness | current value | evidence |
|---|---|---|---|---|---|---|
| chg-01 | Pat Gelsinger is the CEO of Intel. | Y/Y | changed/changed | 0 | Lip-Bu Tan | [link](https://en.wikipedia.org/wiki/Intel) |
| chg-02 | Olaf Scholz is the Chancellor of Germany. | Y/Y | changed/changed | 0 | Friedrich Merz | [link](https://en.wikipedia.org/wiki/Chancellor_of_Germany) |
| chg-03 | Pope Francis is the current Pope. | Y/Y | changed/changed | 0 | Pope Leo XIV | [link](https://en.wikipedia.org/wiki/Pope) |
| chg-04 | Rishi Sunak is the Prime Minister of the United Kingdom. | Y/Y | changed/changed | 0 | Andy Burnham | [link](https://en.wikipedia.org/wiki/Prime_Minister_of_the_United_Kingdom) |
| chg-05 | Joe Biden is the President of the United States. | Y/Y | changed/changed | 0 | Donald Trump | [link](https://www.usa.gov/presidents) |
| chg-06 | Yoon Suk Yeol is the President of South Korea. | Y/Y | changed/changed | 0 | Lee Jae-myung | [link](https://en.wikipedia.org/wiki/President_of_South_Korea) |
| chg-07 | Fumio Kishida is the Prime Minister of Japan. | Y/Y | changed/changed | 0 | Sanae Takaichi | [link](https://en.wikipedia.org/wiki/Prime_Minister_of_Japan) |
| chg-08 | Laxman Narasimhan is the CEO of Starbucks. | Y/Y | changed/changed | 0 | Brian Niccol | [link](https://about.starbucks.com/press/2024/starbucks-names-brian-niccol-as-chairman-and-chief-executive-officer) |
| chg-09 | The latest stable release of Python is Python 3.11. | Y/Y | changed/changed | 0 | Python 3.14 | [link](https://www.liquidweb.com/blog/latest-python-version) |
| chg-10 | The newest Long Term Support release line of Node.js is Node.js 18. | Y/Y | changed/changed | 0 | Node.js 24 | [link](https://hidekazu-konishi.com/entry/nodejs_release_and_eol_timeline.html) |
| chg-11 | The newest iPhone model line is the iPhone 15. | Y/Y | changed/changed | 0 | iPhone 17 | [link](https://www.consumerreports.org/electronics-computers/cell-phones/which-iphone-should-you-buy-a7028071026) |
| chg-12 | Justin Trudeau is the Prime Minister of Canada. | Y/Y | changed/changed | 0 | Mark Carney | [link](https://en.wikipedia.org/wiki/Prime_Minister_of_Canada) |
| chg-13 | The latest version of the Java SE platform is Java 21. | Y/Y | changed/changed | 0 | Java 27 | [link](https://www.codejava.net/java-se/java-se-versions-history) |
| sup-01 | Satya Nadella is the CEO of Microsoft. | Y/Y | supported/supported | 100 |  | [link](https://www.unifygtm.com/insights/executives/microsoft-ceo) |
| sup-02 | Jensen Huang is the CEO of Nvidia. | Y/Y | supported/supported | 100 |  | [link](https://en.wikipedia.org/wiki/Jensen_Huang) |
| sup-03 | Sundar Pichai is the CEO of Alphabet. | Y/Y | supported/supported | 100 |  | [link](https://en.wikipedia.org/wiki/Sundar_Pichai) |
| sup-04 | The US federal minimum wage is $7.25 per hour. | Y/Y | supported/supported | 100 |  | [link](https://statesminimumwage.com/blog/current-federal-minimum-wage-2026) |
| sup-05 | Emmanuel Macron is the President of France. | Y/Y | supported/supported | 100 |  | [link](https://en.wikipedia.org/wiki/President_of_France) |
| sup-06 | Narendra Modi is the Prime Minister of India. | Y/Y | supported/supported | 100 |  | [link](https://en.wikipedia.org/wiki/Prime_Minister_of_India) |
| unv-01 | Zentrovix Labs, a startup in Tallinn, charges 49 euros per month for its Pro plan. | Y/Y | unverifiable/unverifiable | - |  | [link](https://zed.dev/docs/account/plans-and-pricing) |
| unv-02 | The internal codename of Harbor Analytics' next database engine is Bluefin. | Y/Y | unverifiable/unverifiable | - |  | [link](https://tavily.com/knowledge/company/XKCycHf6dXYc) |
| unv-03 | Mirelle Okafor is the current head of procurement at the Lisbon municipal water utility. | Y/Y | unverifiable/unverifiable | - |  | [link](https://pt.linkedin.com/in/ricardo-vila-selas-b503762b/en) |
| nts-01 | Water boils at 100 degrees Celsius at sea level. | N/N | -/- | - |  | - |
| nts-02 | The Treaty of Versailles was signed in 1919. | N/N | -/- | - |  | - |
| nts-03 | Mount Everest lies on the border between Nepal and China. | N/N | -/- | - |  | - |
