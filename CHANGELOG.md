# Changelog

## [1.4.0](https://github.com/gauthamchandra/localstack-gcp/compare/v1.3.0...v1.4.0) (2026-03-14)


### Features

* **workflows:** add execution engine infrastructure and YAML parsing ([#28](https://github.com/gauthamchandra/localstack-gcp/issues/28)) ([9967e2b](https://github.com/gauthamchandra/localstack-gcp/commit/9967e2ba328145561c12e991f0643c8ce917d1bf))

## [1.3.0](https://github.com/gauthamchandra/localstack-gcp/compare/v1.2.0...v1.3.0) (2026-03-09)


### Features

* add automatic semantic versioning with release-please ([#15](https://github.com/gauthamchandra/localstack-gcp/issues/15)) ([6b66dcc](https://github.com/gauthamchandra/localstack-gcp/commit/6b66dccfd4b96cc94bc77ab666957962824f86ab))
* Add HTTP + gRPC layer and request routing logic ([#4](https://github.com/gauthamchandra/localstack-gcp/issues/4)) ([36f6a35](https://github.com/gauthamchandra/localstack-gcp/commit/36f6a3564039e73b0af58eb8c66987e2db67f91b))
* Add SQLite persistence layer ([#3](https://github.com/gauthamchandra/localstack-gcp/issues/3)) ([cfdecb3](https://github.com/gauthamchandra/localstack-gcp/commit/cfdecb3ccde0e86b48a23c8fcb2a84ba1f5bc79f))
* **audit:** add GCP compatibility audit infrastructure ([#16](https://github.com/gauthamchandra/localstack-gcp/issues/16)) ([33e22f3](https://github.com/gauthamchandra/localstack-gcp/commit/33e22f36a25f020a3aded42664ac8ac554f427cd))
* Scaffold app with a Bun Typescript application ([#2](https://github.com/gauthamchandra/localstack-gcp/issues/2)) ([581459a](https://github.com/gauthamchandra/localstack-gcp/commit/581459aa49e6076d4f2e11632d831d4d3fe2cd7c))
* **scheduler:** implement Google Cloud Scheduler service ([#6](https://github.com/gauthamchandra/localstack-gcp/issues/6)) ([1f926cc](https://github.com/gauthamchandra/localstack-gcp/commit/1f926ccabe9fbf99c3a223809a19ceb340712283))
* Setup Knip for unused dependency detection and simplify Husky hooks ([7002e64](https://github.com/gauthamchandra/localstack-gcp/commit/7002e643bdd1aafee6baf8fb786575de6af91adb))
* **storage:** add experimental Google Cloud Storage support ([#26](https://github.com/gauthamchandra/localstack-gcp/issues/26)) ([2f725b3](https://github.com/gauthamchandra/localstack-gcp/commit/2f725b328c034dc94ba900d9e149c8636c887fa3))
* **tasks:** add App Engine, httpTarget, and location endpoint support ([#23](https://github.com/gauthamchandra/localstack-gcp/issues/23)) ([bd23b2a](https://github.com/gauthamchandra/localstack-gcp/commit/bd23b2af9f3f60f6de51e7a167a0167047266de7))
* **tasks:** implement Google Cloud Tasks emulation service ([#11](https://github.com/gauthamchandra/localstack-gcp/issues/11)) ([20aca71](https://github.com/gauthamchandra/localstack-gcp/commit/20aca714cc3b197d285c2a63bc9860a7f8a8016c))
* **workflows:** add Cloud Workflows service emulation ([#24](https://github.com/gauthamchandra/localstack-gcp/issues/24)) ([de403cb](https://github.com/gauthamchandra/localstack-gcp/commit/de403cb376447ef54d56ed0c911d1d3e0a6f4d5f))


### Bug Fixes

* **ci:** add packages key to release-please config ([#17](https://github.com/gauthamchandra/localstack-gcp/issues/17)) ([4e185d1](https://github.com/gauthamchandra/localstack-gcp/commit/4e185d1bb483673359aaef39437e9cb9f0440f9d))
* **ci:** use GitHub App token for release-please ([#19](https://github.com/gauthamchandra/localstack-gcp/issues/19)) ([1c34bdf](https://github.com/gauthamchandra/localstack-gcp/commit/1c34bdf5ac849e213c706de20fbc8e7bcc309f7e))
* **release:** enable version-based Docker image tagging for releases ([#29](https://github.com/gauthamchandra/localstack-gcp/issues/29)) ([c88edd6](https://github.com/gauthamchandra/localstack-gcp/commit/c88edd66bca1da42f6ba5dbc53c011a434bf7dd4))
* **tasks:** fix queue ID parsing and polish Cloud Tasks emulation ([#14](https://github.com/gauthamchandra/localstack-gcp/issues/14)) ([8f0ed38](https://github.com/gauthamchandra/localstack-gcp/commit/8f0ed3871a379e32e5455caf087ba8ebe89a83e0))

## [1.2.0](https://github.com/gauthamchandra/localstack-gcp/compare/localstack-gcp-v1.1.0...localstack-gcp-v1.2.0) (2026-03-09)


### Features

* **storage:** add experimental Google Cloud Storage support ([#26](https://github.com/gauthamchandra/localstack-gcp/issues/26)) ([2f725b3](https://github.com/gauthamchandra/localstack-gcp/commit/2f725b328c034dc94ba900d9e149c8636c887fa3))
* **tasks:** add App Engine, httpTarget, and location endpoint support ([#23](https://github.com/gauthamchandra/localstack-gcp/issues/23)) ([bd23b2a](https://github.com/gauthamchandra/localstack-gcp/commit/bd23b2af9f3f60f6de51e7a167a0167047266de7))
* **workflows:** add Cloud Workflows service emulation ([#24](https://github.com/gauthamchandra/localstack-gcp/issues/24)) ([de403cb](https://github.com/gauthamchandra/localstack-gcp/commit/de403cb376447ef54d56ed0c911d1d3e0a6f4d5f))

## [1.1.0](https://github.com/gauthamchandra/localstack-gcp/compare/localstack-gcp-v1.0.0...localstack-gcp-v1.1.0) (2026-03-08)


### Features

* add automatic semantic versioning with release-please ([#15](https://github.com/gauthamchandra/localstack-gcp/issues/15)) ([6b66dcc](https://github.com/gauthamchandra/localstack-gcp/commit/6b66dccfd4b96cc94bc77ab666957962824f86ab))
* Add HTTP + gRPC layer and request routing logic ([#4](https://github.com/gauthamchandra/localstack-gcp/issues/4)) ([36f6a35](https://github.com/gauthamchandra/localstack-gcp/commit/36f6a3564039e73b0af58eb8c66987e2db67f91b))
* Add SQLite persistence layer ([#3](https://github.com/gauthamchandra/localstack-gcp/issues/3)) ([cfdecb3](https://github.com/gauthamchandra/localstack-gcp/commit/cfdecb3ccde0e86b48a23c8fcb2a84ba1f5bc79f))
* **audit:** add GCP compatibility audit infrastructure ([#16](https://github.com/gauthamchandra/localstack-gcp/issues/16)) ([33e22f3](https://github.com/gauthamchandra/localstack-gcp/commit/33e22f36a25f020a3aded42664ac8ac554f427cd))
* Scaffold app with a Bun Typescript application ([#2](https://github.com/gauthamchandra/localstack-gcp/issues/2)) ([581459a](https://github.com/gauthamchandra/localstack-gcp/commit/581459aa49e6076d4f2e11632d831d4d3fe2cd7c))
* **scheduler:** implement Google Cloud Scheduler service ([#6](https://github.com/gauthamchandra/localstack-gcp/issues/6)) ([1f926cc](https://github.com/gauthamchandra/localstack-gcp/commit/1f926ccabe9fbf99c3a223809a19ceb340712283))
* Setup Knip for unused dependency detection and simplify Husky hooks ([7002e64](https://github.com/gauthamchandra/localstack-gcp/commit/7002e643bdd1aafee6baf8fb786575de6af91adb))
* **tasks:** implement Google Cloud Tasks emulation service ([#11](https://github.com/gauthamchandra/localstack-gcp/issues/11)) ([20aca71](https://github.com/gauthamchandra/localstack-gcp/commit/20aca714cc3b197d285c2a63bc9860a7f8a8016c))


### Bug Fixes

* **ci:** add packages key to release-please config ([#17](https://github.com/gauthamchandra/localstack-gcp/issues/17)) ([4e185d1](https://github.com/gauthamchandra/localstack-gcp/commit/4e185d1bb483673359aaef39437e9cb9f0440f9d))
* **ci:** use GitHub App token for release-please ([#19](https://github.com/gauthamchandra/localstack-gcp/issues/19)) ([1c34bdf](https://github.com/gauthamchandra/localstack-gcp/commit/1c34bdf5ac849e213c706de20fbc8e7bcc309f7e))
* **tasks:** fix queue ID parsing and polish Cloud Tasks emulation ([#14](https://github.com/gauthamchandra/localstack-gcp/issues/14)) ([8f0ed38](https://github.com/gauthamchandra/localstack-gcp/commit/8f0ed3871a379e32e5455caf087ba8ebe89a83e0))
