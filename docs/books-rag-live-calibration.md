# Live relevance calibration

**operator-cosine-v1 provisional** — 2026-10-28. Operator model: `openai-codex/gpt-6.1-sol`.

## Scope and method

Published root `634b999b4a8df734a1314ca4b2e43a1b`: 20 books, 38,464 passages,
2,244 available images. Read-only; no indexing, re-ingestion, uploads, pruning,
original access or provider/model changes. Local Ollama 0.40.11,
`nomic-embed-text:v1.5`, 768 dimensions, cosine; pinned digest
`sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`.

The set and expected books were written before any scores: **30 English
answerable questions + five Spanish questions reformulated to English**, across
**17 expected books**, plus **15 unrelated questions**. Search used only the
English formulation; there is no server translation or LLM call. Every third
row (ID divisible by three) was held out: training 24 positives/10 negatives,
held-out 11 positives/5 negatives. Similar topic pairs and Spanish reformulations
can cross the split; this is not a book-disjoint or topic-disjoint test.

Each row ran the real `searchBooks` against hosted services with a measurement-only
floor 0.01/drop 1 (in memory, not in env), and its expected-book hit, or the top
hit when absent, was read with `readHostedPassage` (limit 4000). No fake-service
results are included. Reader `/tmp/books-rag-live/empty-reader-store` remained
empty. Search hashes/manifest identities were checked by the production path;
all searches and reads completed successfully. Existing extraction gaps remain.

Expected books are fixed labels, **not proof that the top hit answers the
question**. Expected page ranges are optional: ID 1 uses the previously verified
171–172 smoke citation; the other annotated ranges were corroborated after
retrieval using hosted-read location/outline headings (listed below). They are
not independent held-out page gold. A dash means no confirmed expected page
label, not a missing PDF page. Page matching means a hit from the expected book
whose spans overlap the annotated physical PDF range.

The two gates were replayed over the same verified top five (not a second live
50-query run). Floor/drop filters are monotone over descending scores, so no
candidate ranked below five can replace a rejected top-five candidate. This
exactly computes the configured returned top-five subset without spending
another full fan-out. Top-two margin is diagnostic: best minus second score;
**the configured margin is maximum allowed drop behind the best, not a minimum
separation between first and second**. It cannot reject an unrelated top hit.

## Choice (training only)

Training maximum unrelated top score: **0.659119606**. Minimum score of the best
expected-book hit among training questions with such a hit: **0.699506044**.
Choose floor **0.68**, near the midpoint of that gap: 0.020880394 above the
highest training negative and 0.019506044 below the lowest training correct-book
hit. The largest drop needed to retain a training expected-book hit is
0.031125725; choose drop **0.05**, rounded up with headroom. This retains the
maximum attainable expected-book recall on the measured training top-five set
while accepting zero training negatives; increasing drop cannot recover the
missing expected book for ID 1. No per-question settings or answer logic.

Held-out results were reported unchanged, not used to revise these values.
Its highest unrelated score is 0.648349881. The entire set has zero unrelated
acceptances at the chosen values. Source defaults remain 0.78/0.08. The private
env alone now sets `BOOKS_RELEVANCE_FLOOR=0.68` and
`BOOKS_RELEVANCE_MARGIN=0.05`, after a mode-600 backup in `/tmp`.

| Gate | Split | Raw expected-book recall@5 | Gated expected-book recall@5 | Positive searches accepted | Unrelated false accepts |
|---|---|---:|---:|---:|---:|
| synthetic 0.78 / 0.08 | training | 23/24 (95.83%) | 13/24 (54.17%) | 13/24 | 0/10 |
| synthetic 0.78 / 0.08 | held-out | 11/11 (100%) | 5/11 (45.45%) | 5/11 | 0/5 |
| operator 0.68 / 0.05 | training | 23/24 (95.83%) | 23/24 (95.83%) | 24/24 | 0/10 |
| operator 0.68 / 0.05 | held-out | 11/11 (100%) | 11/11 (100%) | 11/11 | 0/5 |

Combined gated expected-book recall: **34/35 (97.14%)** versus baseline 18/35
(51.43%). ID 1 is accepted with other books but misses its expected book;
acceptance rate must not be mistaken for correct retrieval.

## Response budget

Pinecone accounting: **1,053 physical responses, 79,583,509 B including
8,192 B/attempt conservative envelope**; body bytes 70,957,333 B. Before each
request the adapter accounting callback reserved the maximum response plus
envelope, refusing dispatch if settled bytes + outstanding reservation would
exceed **150,000,000 B**. Completed responses settled to actual body bytes.
Retries were disabled; no quota errors or outstanding reservations. The meter
includes all query fan-outs, Pinecone validation probes and all 50 passage
fetches in this run. It excludes S3/Ollama bytes, other processes and later
doctor/CLI smoke; it is not TLS traffic, RU accounting or a billing guarantee.

Private operational set, runner, log and compact results remain under
`/tmp/books-cal-*`; no prose or credentials are committed.

## Book labels

| Alias | Book ID | Title |
|---|---|---|
| B1 | `book_a89f5fd8e8cf4b590cbab61bfb843c58` | Hands-On Large Language Models |
| B2 | `book_c1040240939db69dfd9893b3854486e9` | Generative AI Design Patterns |
| B3 | `book_d264df0079bc05ff65060cc305a4f7ec` | Data Engineering Design Patterns |
| B4 | `book_940319bd36b883d45bc715c620177532` | Storytelling with Data |
| B5 | `book_9c3cf17d475903319acf8d229df47683` | Fundamentals of Data Engineering |
| B6 | `book_8e722e0cee01180bd1202963bd55edd2` | Building Generative AI Services with FastAPI |
| B7 | `book_d303ab392161947f5b543c153f14098f` | Building Applications with AI Agents |
| B8 | `book_142f3b1bac2b9dcd85f24ed2004dfd48` | Building Microservices |
| B9 | `book_4e0ee4357589e87cab283d43730e8b81` | AI Engineering: Building Applications With Foundation Models |
| B10 | `book_00d667914fc89268c02cc1433af1a154` | Deep Learning with Python |
| B11 | `book_6d05361d52b5d2684b9f76dbbb9475ff` | C++ Software Design |
| B12 | `book_185b2e55c30ffc02cd8b09f33da0b097` | A Philosophy of Software Design |
| B13 | `book_8709c3c99e76e9ad233b6e4b733ce01e` | Hands-On Machine Learning with Scikit-Learn and TensorFlow |
| B14 | `book_0bbe39e8832ec0fc9a62de3f57d30e1b` | Designing Data-Intensive Applications |
| B15 | `book_191e44b4a3a612b8b2baf78e23561cc5` | Practical MLOps |
| B16 | `book_b8719a5d94d532dce227c4f59a0541f3` | Mastering API Architecture |
| X1 | `book_2cb5bfc37be30316225300eb97341bc8` | Unknown title |
| X2 | `book_f7baa8ba0ba1a3d610cd140d45680376` | Unknown title |
| B17 | `book_344683f3cfc38cfac10252dbd1d8201f` | Designing Machine Learning Systems |
| X3 | `book_9d469b8be7f65b5b08b3ce3c5aaba9b7` | Data Science: The Hard Parts |

## Per-query results

T = training; H = held-out. A = accepted; – = abstained. Raw5 / gated5
report expected-book membership, not answer support. Page5 reports raw/gated
page overlap when an expected range is annotated. All scores are cosine.

| ID | Split | English query actually sent | Expected | Expected PDF range | Top score | Top−second | Baseline | Operator | Raw5 / gated5 | Page5 raw/gated |
|---|---|---|---|---|---:|---:|---|---|---|---|
| 1 | T | How can I group adjacent document sentences by meaning before putting them into a retrieval index? | B2 | 171–172 | 0.709606528 | 0.008420109 | – | A | no / no | no / no |
| 2 | T | Why do transformer attention layers need information about token position? | B1 | — | 0.797966421 | 0.015781761 | A | A | yes / yes | — |
| 3 | H | How can I adapt a pretrained language model using low rank weight updates instead of training all its weights? | B1 | — | 0.773648620 | 0.013698221 | – | A | yes / yes | — |
| 4 | T | How should I choose a business capability boundary when splitting a service? | B8 | — | 0.718976736 | 0.004806736 | – | A | yes / yes | — |
| 5 | T | How can independent services avoid breaking consumers when deploying a contract change? | B8 | — | 0.736638486 | 0.018154084 | – | A | yes / yes | — |
| 6 | H | Why can hiding implementation details behind a small interface make a module easier to understand? | B12 | — | 0.783584058 | 0.012054860 | A | A | yes / yes | — |
| 7 | T | When does breaking a class into many small methods increase rather than reduce complexity? | B12 | — | 0.817693830 | 0.032453537 | A | A | yes / yes | — |
| 8 | T | How should an API evolve without forcing all existing clients to upgrade at once? | B16 | 54 | 0.785797000 | 0.000532270 | A | A | yes / yes | yes / yes |
| 9 | H | Where should authentication and rate limiting live when exposing services through an API gateway? | B16 | — | 0.784203053 | 0.000206053 | A | A | yes / yes | — |
| 10 | T | Why can a leader replica acknowledge a write before follower replicas have received it? | B14 | — | 0.798279822 | 0.000886822 | A | A | yes / yes | — |
| 11 | T | How does a database transaction prevent concurrent updates from losing each other's changes? | B14 | 268 | 0.839446783 | 0.021026969 | A | A | yes / yes | yes / yes |
| 12 | H | What should I measure to detect that a deployed model's input data has changed? | B17 | 262 | 0.768153191 | 0.013834715 | – | A | yes / yes | yes / yes |
| 13 | T | How do training data features differ from the features available to a model serving online predictions? | B17 | — | 0.809652328 | 0.022054493 | A | A | yes / yes | — |
| 14 | T | How can dropout reduce overfitting when training a neural network? | B10 | 133 | 0.895094872 | 0.028387666 | A | A | yes / yes | yes / yes |
| 15 | H | Why do convolutional networks share weights across positions in an image? | B10 | 146 | 0.772392869 | 0.009503007 | – | A | yes / yes | yes / yes |
| 16 | T | How can cross validation help choose hyperparameters without overfitting the test set? | B13 | 58 | 0.788442850 | 0.000849604 | A | A | yes / yes | yes / yes |
| 17 | T | How do random forests combine decision trees to improve predictions? | B13 | — | 0.799117208 | 0.002062798 | A | A | yes / yes | — |
| 18 | H | How should I choose between streaming and batch ingestion for a data pipeline? | B5 | 282 | 0.841366768 | 0.000688315 | A | A | yes / yes | yes / yes |
| 19 | T | What tradeoffs matter when choosing a data warehouse versus a data lake? | B5 | — | 0.739369512 | 0.007130862 | – | A | yes / yes | — |
| 20 | T | How can an incremental data pipeline capture only changed source records? | B3 | 34 | 0.721864343 | 0.013622821 | – | A | yes / yes | yes / yes |
| 21 | H | How can a pipeline handle events that arrive later than their event timestamps? | B3 | 69 | 0.760246217 | 0.022685408 | – | A | yes / yes | yes / yes |
| 22 | T | How can removing chart clutter help an audience focus on the important comparison? | B4 | 210 | 0.768393159 | 0.007282734 | – | A | yes / yes | yes / yes |
| 23 | T | When should I use a bar chart instead of a pie chart to compare categories? | B4 | 80 | 0.823740363 | 0.021884262 | A | A | yes / yes | yes / yes |
| 24 | H | How does dependency injection make FastAPI request handlers easier to test? | B6 | 55–56 | 0.833660185 | 0.008117139 | A | A | yes / yes | yes / yes |
| 25 | T | How can an asynchronous Python API stream generated tokens back to a client? | B6 | — | 0.748671114 | 0.029753387 | – | A | yes / yes | — |
| 26 | T | How does an agent decide when to call a tool instead of answering directly? | B7 | — | 0.807093740 | 0.019298971 | A | A | yes / yes | — |
| 27 | H | How can I evaluate whether a language model response is grounded in retrieved documents? | B9 | — | 0.721792817 | 0.004700303 | – | A | yes / yes | — |
| 28 | T | What tradeoffs should guide choosing an embedding model for document retrieval? | B9 | 575–577 | 0.765016913 | 0.003381192 | – | A | yes / yes | yes / yes |
| 29 | T | How can type erasure let C++ code use different concrete types through one interface? | B11 | — | 0.811068058 | 0.013423204 | A | A | yes / yes | — |
| 30 | H | How can a continuous integration pipeline test and deploy machine learning models? | B15 | 134 | 0.807893574 | 0.001120627 | A | A | yes / yes | yes / yes |
| 31 | T | How can I detect distribution changes in the data a deployed model receives? | B17 | 262 | 0.773585320 | 0.016832948 | – | A | yes / yes | yes / yes |
| 32 | T | How can I avoid breaking old clients when changing an API? | B16 | 54 | 0.732010305 | 0.005590141 | – | A | yes / yes | yes / yes |
| 33 | H | Why does hiding internal decisions make software modules simpler? | B12 | — | 0.755059183 | 0.012000025 | – | A | yes / yes | — |
| 34 | T | How should I decide whether to ingest data continuously or in scheduled batches? | B5 | 263 | 0.790996552 | 0.021103144 | A | A | yes / yes | yes / yes |
| 35 | T | How can a chart direct the audience's attention to the most important finding? | B4 | — | 0.757116199 | 0.033155799 | – | A | yes / yes | — |
| 36 | H | How long should I bake sourdough bread in a Dutch oven? | unrelated | — | 0.590542436 | 0.011018873 | – | – | n/a | — |
| 37 | T | What ingredients do I need for a traditional mushroom risotto? | unrelated | — | 0.624995828 | 0.013214231 | – | – | n/a | — |
| 38 | T | What is the offside rule in association football? | unrelated | — | 0.630189180 | 0.003864288 | – | – | n/a | — |
| 39 | H | How are points scored in a tennis tiebreak? | unrelated | — | 0.648349881 | 0.003565073 | – | – | n/a | — |
| 40 | T | Why does Saturn have rings made of ice? | unrelated | — | 0.548768759 | 0.000167966 | – | – | n/a | — |
| 41 | T | How does a lunar eclipse differ from a solar eclipse? | unrelated | — | 0.583245814 | 0.000667989 | – | – | n/a | — |
| 42 | H | What are the legal requirements for making a valid will in England? | unrelated | — | 0.629281640 | 0.010696351 | – | – | n/a | — |
| 43 | T | How does a tenant contest an eviction notice in California? | unrelated | — | 0.622024059 | 0.004383146 | – | – | n/a | — |
| 44 | T | What are the symptoms of iron deficiency anemia? | unrelated | — | 0.568628907 | 0.011504233 | – | – | n/a | — |
| 45 | H | Which vaccines are recommended before travel to yellow fever regions? | unrelated | — | 0.615294874 | 0.007600546 | – | – | n/a | — |
| 46 | T | How should I prune a rose bush in winter? | unrelated | — | 0.580767274 | 0.006310225 | – | – | n/a | — |
| 47 | T | Which brush technique creates a watercolor sky? | unrelated | — | 0.659119606 | 0.008444309 | – | – | n/a | — |
| 48 | H | How do I tune the strings on a violin? | unrelated | — | 0.640992880 | 0.003491044 | – | – | n/a | — |
| 49 | T | What caused the collapse of the Western Roman Empire? | unrelated | — | 0.618374944 | 0.001257944 | – | – | n/a | — |
| 50 | T | How do coral reefs reproduce in tropical seas? | unrelated | — | 0.632682204 | 0.021477103 | – | – | n/a | — |

### Spanish originals (English reformulations above)

- 31: ¿Cómo detecto cambios en los datos que recibe un modelo desplegado?
- 32: ¿Cómo evito romper clientes antiguos al cambiar una API?
- 33: ¿Por qué ocultar decisiones internas simplifica los módulos?
- 34: ¿Cómo decido entre ingerir datos continuamente o por lotes programados?
- 35: ¿Cómo puede un gráfico dirigir la atención al hallazgo más importante?

### Verified top five and read citations

Each top-five entry is alias @ physical PDF range : score, in descending order.
The read citation is the expected-book candidate when available, otherwise the
top diagnostic candidate. Headings are metadata, not passage quotations.

| ID | Raw top five | Hosted read passage / book / PDF pages / heading path |
|---|---|---|
| 1 | B6 @ 230 : 0.709606528<br>B1 @ 331–333 : 0.701186419<br>B9 @ 561–562 : 0.698988080<br>B1 @ 330–331 : 0.698787630<br>B9 @ 565–566 : 0.697401822 | `passage_aac792f41dd10748f7bc06f83766be6d` / B6 / 230 / Project: Talk to Documents (RAG) |
| 2 | B9 @ 154–155 : 0.797966421<br>B1 @ 144–145 : 0.782184660<br>B1 @ 136–138 : 0.772582173<br>B1 @ 158 : 0.762705000<br>B1 @ 135–136 : 0.747072875 | `passage_57762ff838951e880d6dd81df2de79a1` / B1 / 144–145 / Architecture → More Efficient Attention |
| 3 | B2 @ 318–320 : 0.773648620<br>B9 @ 112–113 : 0.759950399<br>B2 @ 40 : 0.753474772<br>B1 @ 533 : 0.748668790<br>B1 @ 473 : 0.746548653 | `passage_0b21258e854d76fd4c0d5c8c9df5cd42` / B1 / 533 / Reward Models → Summary |
| 4 | B8 @ 90 : 0.718976736<br>B8 @ 22–23 : 0.714170000<br>B8 @ 651–652 : 0.695311546<br>B16 @ 127 : 0.694893122<br>B8 @ 98 : 0.692353845 | `passage_4a403e92a37d4b6a5bfdf291bf06cdf0` / B8 / 90 / Alternatives to Business Domain Boundaries |
| 5 | B8 @ 21–22 : 0.736638486<br>B8 @ 197 : 0.718484402<br>B8 @ 186 : 0.713745892<br>B8 @ 372–373 : 0.706252456<br>B8 @ 192 : 0.703234673 | `passage_f5b045f2c330cabcc912b4c243a10bf0` / B8 / 21–22 / Independent Deployability |
| 6 | B12 @ 39 : 0.783584058<br>B8 @ 160 : 0.771529198<br>B12 @ 40–41 : 0.769956470<br>B8 @ 59–60 : 0.766407132<br>B12 @ 48 : 0.759777069 | `passage_5ee3d4921ace11b7b134164b26d0104d` / B12 / 39 / Red Flag: Shallow Module → 4.8 Conclusion |
| 7 | B12 @ 45 : 0.817693830<br>B12 @ 80 : 0.785240293<br>B12 @ 37–38 : 0.775742471<br>B12 @ 67–68 : 0.740578890<br>B12 @ 82 : 0.732356000 | `passage_ae226ef4473e051c3e701f9c3e6425e9` / B12 / 45 / Red Flag: Temporal Decomposition → 5.5 Example: too many classes |
| 8 | B16 @ 54 : 0.785797000<br>B16 @ 53 : 0.785264730<br>B16 @ 168 : 0.759150863<br>B16 @ 227 : 0.754972935<br>B16 @ 247 : 0.752350748 | `passage_c9f309a4004df1b47cafe5fbc33bea09` / B16 / 54 / Design, Build, and Specify APIs → API Versioning |
| 9 | B16 @ 197 : 0.784203053<br>B6 @ 417–418 : 0.783997000<br>B6 @ 424 : 0.769126773<br>B16 @ 102 : 0.765866816<br>B16 @ 95 : 0.758524060 | `passage_d2f87ca87fbe960934f87f46be01ee9d` / B16 / 197 / Threat Modeling for APIs → How to Threat Model → Step 4: Identify Threats—Taking This in Your STRIDE |
| 10 | B14 @ 174 : 0.798279822<br>B14 @ 185 : 0.797393000<br>B14 @ 185 : 0.793458939<br>B14 @ 184 : 0.789258897<br>B14 @ 176 : 0.780854225 | `passage_7158e3ad929c352b9b04b6c9a4bf369a` / B14 / 174 / Replication → Leaders and Followers |
| 11 | B14 @ 268 : 0.839446783<br>B14 @ 267 : 0.818419814<br>B14 @ 266 : 0.805413842<br>B14 @ 267 : 0.802511811<br>B14 @ 265 : 0.797280073 | `passage_2cb822c7bf6c12117a6c923380748d60` / B14 / 268 / Transactions → Weak Isolation Levels → Preventing Lost Updates |
| 12 | B17 @ 262 : 0.768153191<br>B7 @ 259 : 0.754318476<br>B17 @ 245–246 : 0.750955403<br>B7 @ 261 : 0.750824630<br>B17 @ 274 : 0.746634722 | `passage_bcf64135130220dc97db9253213ea022` / B17 / 262 / Data Distribution Shifts and Monitoring → Data Distribution Shifts → Detecting Data Distribution Shifts |
| 13 | B17 @ 219 : 0.809652328<br>B17 @ 224 : 0.787597835<br>B17 @ 220 : 0.786556900<br>B17 @ 221 : 0.772808790<br>B17 @ 217 : 0.770478249 | `passage_ad0457aad1b558368d089cdd305c89ae` / B17 / 219 / Model Deployment and Prediction Service → Batch Prediction Versus Online Prediction |
| 14 | B13 @ 385 : 0.895094872<br>B13 @ 383 : 0.866707206<br>B10 @ 133 : 0.863969147<br>B13 @ 384 : 0.863328000<br>B13 @ 385 : 0.857117057 | `passage_4298b452966b673897e7df0dfe4d550a` / B10 / 133 / machine learning → 4.4 Overfitting and underfitting → 4.4.3 Adding dropout |
| 15 | B13 @ 463 : 0.772392869<br>B10 @ 146 : 0.762889862<br>B13 @ 499 : 0.760255158<br>B13 @ 464 : 0.759207487<br>B13 @ 460 : 0.747532308 | `passage_2da200d6eebf3228f99dc08ec882a0d9` / B10 / 146 / for computer vision → 5.1 Introduction to convnets → 5.1.1 The convolution operation |
| 16 | B13 @ 58 : 0.788442850<br>B13 @ 105 : 0.787593246<br>B13 @ 58 : 0.782440543<br>B13 @ 109 : 0.762410760<br>B13 @ 61 : 0.761371195 | `passage_a712992d8826502a327b9042f6e2af02` / B13 / 58 / The Machine Learning Landscape → Testing and Validating → Hyperparameter Tuning and Model Selection |
| 17 | B13 @ 216 : 0.799117208<br>B13 @ 217 : 0.797054410<br>B13 @ 104 : 0.787647963<br>B13 @ 215 : 0.784362555<br>B13 @ 222 : 0.783446491 | `passage_cbd7091722ff3dc83d9e380eb48af6d2` / B13 / 216 / Decision Trees → Exercises |
| 18 | B5 @ 282 : 0.841366768<br>B5 @ 67 : 0.840678453<br>B5 @ 67 : 0.814237475<br>B5 @ 295 : 0.808651328<br>B5 @ 264 : 0.806649566 | `passage_aeb58d83c797cf4b821b05668afd4a3c` / B5 / 282 / Ingestion → Ways to Ingest Data → Message Queues and Event-Streaming Platforms |
| 19 | B5 @ 129 : 0.739369512<br>B5 @ 242 : 0.732238650<br>B5 @ 243 : 0.724297881<br>B5 @ 242 : 0.717842698<br>B5 @ 128 : 0.711402297 | `passage_1c35f9025213ace21125773a91e53275` / B5 / 129 / Designing Good Data Architecture → Examples and Types of Data Architecture → Convergence, Next-Generation Data Lakes, and the Data Platform |
| 20 | B14 @ 477 : 0.721864343<br>B14 @ 476 : 0.708241522<br>B14 @ 476 : 0.708228707<br>B14 @ 477 : 0.700793147<br>B3 @ 34 : 0.699506044 | `passage_b025c86c31c61a5d4a7ba07a1b287007` / B3 / 34 / Data Ingestion Design Patterns → Incremental Load → Pattern: Change Data Capture |
| 21 | B14 @ 493 : 0.760246217<br>B14 @ 492 : 0.737560809<br>B5 @ 274 : 0.736057043<br>B14 @ 491 : 0.729922175<br>B3 @ 69 : 0.720584035 | `passage_c649bae7ee7d7fc89a25c83427abceeb` / B3 / 69 / Error Management Design Patterns → Late Data → Pattern: Late Data Detector |
| 22 | B4 @ 210 : 0.768393159<br>B4 @ 105 : 0.761110425<br>B4 @ 114 : 0.752990425<br>B4 @ 106 : 0.744576931<br>B4 @ 270 : 0.741268635 | `passage_c03a5959309d22054f2a4e68449d1469` / B4 / 210 / pulling it all together → Lesson 3: eliminate clutter |
| 23 | B4 @ 80 : 0.823740363<br>B4 @ 252 : 0.801856101<br>X2 @ 378 : 0.777866721<br>B4 @ 66 : 0.769187093<br>B4 @ 80 : 0.765642583 | `passage_caec673dd560307b84b581b3513930c1` / B4 / 80 / I  → To be avoided → Pie charts are evil |
| 24 | B6 @ 55–56 : 0.833660185<br>B6 @ 56 : 0.825543046<br>B6 @ 55 : 0.817497909<br>B6 @ 609–610 : 0.785572410<br>B6 @ 56 : 0.777520239 | `passage_ce16fb1a67b848bc4e71d6ae2851aa08` / B6 / 55–56 / Dependency Injection System |
| 25 | B6 @ 205 : 0.748671114<br>B6 @ 360–361 : 0.718917727<br>B6 @ 286 : 0.717067361<br>B6 @ 205 : 0.715571463<br>B6 @ 207 : 0.705157638 | `passage_48f4c14ebbae8323a76fd78d8cefd8f2` / B6 / 205 / Async Programming with Model Provider APIs |
| 26 | X1 @ 364 : 0.807093740<br>B2 @ 420–421 : 0.787794769<br>B7 @ 39 : 0.785634100<br>B9 @ 640–641 : 0.772208154<br>B9 @ 629 : 0.765769362 | `passage_c008d0f6ab169f2fd10e8c8153ebae4c` / B7 / 39 / Designing Agent Systems → Our First Agent System |
| 27 | B17 @ 120 : 0.721792817<br>B9 @ 1005–1007 : 0.717092514<br>B9 @ 45 : 0.716706634<br>B6 @ 98 : 0.714812934<br>B6 @ 99 : 0.713704824 | `passage_454c115bbccc6519ffc85e1ed34e50aa` / B9 / 1005–1007 / Natural language feedback |
| 28 | B2 @ 196 : 0.765016913<br>B2 @ 195–196 : 0.761635721<br>B2 @ 184 : 0.758665144<br>B9 @ 575–577 : 0.751493000<br>B2 @ 185–186 : 0.748464584 | `passage_e59cc631644fb77c7109a3753c91d8fc` / B9 / 575–577 / Comparing retrieval algorithms |
| 29 | B11 @ 441 : 0.811068058<br>B11 @ 416 : 0.797644854<br>B11 @ 464 : 0.771002889<br>B11 @ 442–443 : 0.758581519<br>B11 @ 438 : 0.742132127 | `passage_5834404331f51a1ce1758ba4f9c0a550` / B11 / 441 / Pattern → A Word About Terminology |
| 30 | B15 @ 134 : 0.807893574<br>B15 @ 132 : 0.806772947<br>B15 @ 130 : 0.783675671<br>B15 @ 34 : 0.772084177<br>B15 @ 114 : 0.766277075 | `passage_c457f30e7963f97ebe8f56721f186ff9` / B15 / 134 / ML Models → Using Cloud Pipelines → Testing Techniques for Model Deployment |
| 31 | B17 @ 262 : 0.773585320<br>B17 @ 245–246 : 0.756752372<br>B7 @ 259 : 0.754154921<br>B17 @ 270 : 0.745790720<br>B17 @ 282 : 0.743777215 | `passage_bcf64135130220dc97db9253213ea022` / B17 / 262 / Data Distribution Shifts and Monitoring → Data Distribution Shifts → Detecting Data Distribution Shifts |
| 32 | B16 @ 54 : 0.732010305<br>B16 @ 53 : 0.726420164<br>B8 @ 186 : 0.720396519<br>B8 @ 191–192 : 0.707686663<br>B8 @ 190 : 0.700387418 | `passage_c9f309a4004df1b47cafe5fbc33bea09` / B16 / 54 / Design, Build, and Specify APIs → API Versioning |
| 33 | B8 @ 59–60 : 0.755059183<br>B12 @ 48 : 0.743059158<br>B8 @ 58–59 : 0.734988000<br>B12 @ 40–41 : 0.730667000<br>B12 @ 48–49 : 0.727454305 | `passage_2f91d7d5256bf5b79f5761425a4654e7` / B12 / 48 / Red Flag: Overexposure → 5.9 Taking it too far |
| 34 | B5 @ 263 : 0.790996552<br>B5 @ 67 : 0.769893408<br>B5 @ 271 : 0.760010481<br>B5 @ 270 : 0.758918822<br>B5 @ 266 : 0.751857877 | `passage_157b76c799a609543ee89a3cf474266b` / B5 / 263 / Ingestion → Key Engineering Considerations for the Ingestion Phase → Frequency |
| 35 | B4 @ 141 : 0.757116199<br>B4 @ 66 : 0.723960400<br>B4 @ 246 : 0.723511934<br>B4 @ 205 : 0.722911358<br>B4 @ 130 : 0.721539736 | `passage_89145edd54e5b3df6357c45c6f804617` / B4 / 141 / W  → Position on page |
| 36 | X1 @ 368 : 0.590542436<br>B8 @ 495 : 0.579523563<br>B8 @ 553 : 0.574489236<br>B8 @ 495–496 : 0.570596933<br>B8 @ 554 : 0.566264510 | `passage_05d1cc70edb0e7557deb74a6a016bdd7` / X1 / 368 / Iterative Prompting / Refinement |
| 37 | B2 @ 51 : 0.624995828<br>B2 @ 51 : 0.611781597<br>B2 @ 51 : 0.585467160<br>B9 @ 489 : 0.579164207<br>B15 @ 342 : 0.575971305 | `passage_6f5cf92730707298a1936b18c9b86bed` / B2 / 51 / Style |
| 38 | B7 @ 165 : 0.630189180<br>B2 @ 287 : 0.626324892<br>X1 @ 202 : 0.625503302<br>X2 @ 466 : 0.623103857<br>X1 @ 157 : 0.623096824 | `passage_e507b977d926294363a9cd975149f089` / B7 / 165 / Learning in Agentic Systems → Nonparametric Learning → Experiential Learning |
| 39 | B2 @ 428 : 0.648349881<br>B2 @ 287 : 0.644784808<br>B2 @ 290–291 : 0.643787146<br>B9 @ 581 : 0.637864053<br>X3 @ 149 : 0.636549771 | `passage_e714476d111bc53d51fe776a27cecee1` / B2 / 428 / Example |
| 40 | B2 @ 159 : 0.548768759<br>B13 @ 309 : 0.548600793<br>B6 @ 124–125 : 0.540055454<br>B6 @ 29 : 0.539510727<br>B6 @ 129–130 : 0.536173940 | `passage_afc2619ac6bfef82810102931f7966cf` / B2 / 159 / Solution |
| 41 | B2 @ 159–160 : 0.583245814<br>B2 @ 159 : 0.582577825<br>B7 @ 99 : 0.579794168<br>B15 @ 140 : 0.573632300<br>B14 @ 209 : 0.572744131 | `passage_2c0d5542a5976acfb427e0eb0fedb0be` / B2 / 159–160 / Solution |
| 42 | B8 @ 602 : 0.629281640<br>B2 @ 367 : 0.618585289<br>B2 @ 110–111 : 0.618492067<br>B8 @ 466–467 : 0.606320262<br>B9 @ 802 : 0.599793196 | `passage_e80aab1a09b9cff7ea9f1d7ec7eab203` / B8 / 602 / GraphQL → Summary |
| 43 | B6 @ 444–445 : 0.622024059<br>B3 @ 223 : 0.617640913<br>B14 @ 324 : 0.605056822<br>B3 @ 221 : 0.601969242<br>B13 @ 65 : 0.600094676 | `passage_c6171f938023843135059b2157ea1522` / B6 / 444–445 / Caching |
| 44 | X2 @ 291 : 0.568628907<br>X2 @ 291 : 0.557124674<br>X2 @ 430 : 0.556177258<br>B5 @ 302 : 0.554353535<br>B8 @ 363 : 0.554109454 | `passage_1f9fb98a3df089037b6bde5fbb44b599` / X2 / 291 / 10 |
| 45 | B15 @ 141 : 0.615294874<br>X3 @ 92 : 0.607694328<br>B11 @ 205 : 0.603898525<br>B11 @ 229 : 0.600185633<br>X3 @ 93 : 0.599640548 | `passage_727b48f75b5027913785788e172f5fbd` / B15 / 141 / AutoML and KaizenML → AutoML |
| 46 | B1 @ 70 : 0.580767274<br>B13 @ 205 : 0.574457049<br>B9 @ 904–905 : 0.573615670<br>B17 @ 228 : 0.571951389<br>B6 @ 644 : 0.570527792 | `passage_b75dbab8aefff9b24994c9a0bb29c202` / B1 / 70 / Model → Downloading and Running an LLM |
| 47 | B2 @ 37–38 : 0.659119606<br>X2 @ 389 : 0.650675297<br>B2 @ 36–37 : 0.648369610<br>B6 @ 29 : 0.642408000<br>B6 @ 130–131 : 0.636635244 | `passage_98e2f933ff3816c7ff8bc07ea0cbf3e3` / B2 / 37–38 / Few-Shot Learning |
| 48 | B1 @ 509 : 0.640992880<br>B1 @ 508 : 0.637501836<br>B2 @ 134 : 0.635502934<br>B6 @ 472–473 : 0.632507443<br>B9 @ 687 : 0.630696535 | `passage_87f119c0e4894d8de8df66f91f9b1fd2` / B1 / 509 / Tuning → Instruction Tuning with QLoRA → Training Configuration |
| 49 | B14 @ 326 : 0.618374944<br>B8 @ 519 : 0.617117000<br>B8 @ 516–517 : 0.612191319<br>B2 @ 448 : 0.603100419<br>X1 @ 26 : 0.600652933 | `passage_9d1e74cc0f3d6bd9ddf74c070753f73b` / B14 / 326 / The Trouble with Distributed Systems → Knowledge, Truth, and Lies → Byzantine Faults |
| 50 | B15 @ 102 : 0.632682204<br>B15 @ 101 : 0.611205101<br>B15 @ 102 : 0.604200482<br>B15 @ 103 : 0.598671079<br>B8 @ 536 : 0.597206295 | `passage_f964141b558dc6e0ac9c60696e4457eb` / B15 / 102 / MLOps for Containers and Edge Devices → Edge Devices → Coral |

## Limitations and follow-up

Small purposive sample, one corpus/chunk configuration and one embedding model;
no statistical guarantee of zero future false accepts. Related questions cross
the split. Book-level recall is weaker than passage-level answer correctness;
some returned headings are summaries/exercises rather than direct support.
Page annotations are partial and mostly post-retrieval corroborations, not
independent localization ground truth. The paraphrased chunking question misses
its designated book despite other-domain hits. Extraction gaps and missing
lexical retrieval can hide support. The operator gate is provisional, not a
confidence estimate; read and assess passages before citing them. Recalibrate
after any corpus, model or chunking change, preferably using more independent
questions and book/topic-disjoint evaluation.

Verification: `node packages/books-rag/src/cli.ts doctor --env-file <private-env>` reported
`doctor: ready`, pinned Ollama verified, Pinecone compatible, privacy check
passed and 20 committed books. No source default constants were changed.
