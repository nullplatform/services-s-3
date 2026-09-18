# Changelog

## [0.4.0](https://github.com/nullplatform/services-s-3/compare/v0.3.2...v0.4.0) (2026-09-18)


### Features

* dependabot for base image bumps and container image scan ([48a84e6](https://github.com/nullplatform/services-s-3/commit/48a84e66127aa4dc912752fc3699b8d8c3737794))
* dependabot for base image bumps and container image scan ([9e58a82](https://github.com/nullplatform/services-s-3/commit/9e58a825219e151cfcc272f909c0e56bbd918f05))


### Bug Fixes

* **ci:** auto-merge the release PR from workflow_run; Dependabot commits as fix(deps) ([e91a8dc](https://github.com/nullplatform/services-s-3/commit/e91a8dcb7a2b1a07100748239b7868a0aff1c785))
* **deps:** bump nullplatform/scopes/worker-bridge from 1.0.0 to 1.1.1 ([4094424](https://github.com/nullplatform/services-s-3/commit/40944242d24c5d851aa9a30ef17518f5830bd94c))
* grant actions read to the image scan job — the reusable declares it ([71084a0](https://github.com/nullplatform/services-s-3/commit/71084a000aac497edb7c855ca1df26e9b8619807))

## [0.3.2](https://github.com/nullplatform/services-s-3/compare/v0.3.1...v0.3.2) (2026-09-14)


### Bug Fixes

* **deps:** bump OpenTofu to 1.12.6 ([#24](https://github.com/nullplatform/services-s-3/issues/24)) ([bae8881](https://github.com/nullplatform/services-s-3/commit/bae8881c54a8b86e5eadcd687397b5dffd1d5655))

## [0.3.1](https://github.com/nullplatform/services-s-3/compare/v0.3.0...v0.3.1) (2026-09-03)


### Bug Fixes

* delete workflow shouldn't require bucket_name_suffix ([467321b](https://github.com/nullplatform/services-s-3/commit/467321b9cfe9d9dd4a464b2d5b34e0ebc57e3f92))
* don't require bucket_name_suffix when bucket_name already exists ([d48a0bf](https://github.com/nullplatform/services-s-3/commit/d48a0bf8047a674a65e24139621200741e9d2a3f))

## [0.3.0](https://github.com/nullplatform/services-s-3/compare/v0.2.0...v0.3.0) (2026-09-01)


### Features

* **ci:** build+push the worker image and register its artifact on release ([04fc9f7](https://github.com/nullplatform/services-s-3/commit/04fc9f7140b8dae522a8f8162a763bdbc26d62f3))
* **ci:** build+push the worker image and register its artifact on release ([e384665](https://github.com/nullplatform/services-s-3/commit/e384665f392db8102211b2d2493d2a718bc5dfa0))

## [0.2.0](https://github.com/nullplatform/services-s-3/compare/v0.1.1...v0.2.0) (2026-07-28)


### Features

* assume-role support for the aws-s3-bucket service + requirements module ([#12](https://github.com/nullplatform/services-s-3/issues/12)) ([60cc130](https://github.com/nullplatform/services-s-3/commit/60cc1301e0197ea7f06457c0574afcadeaaf5956))


### Bug Fixes

* drop --limit from np provider list (incompatible with --categories) ([#16](https://github.com/nullplatform/services-s-3/issues/16)) ([151d87b](https://github.com/nullplatform/services-s-3/commit/151d87bebc327e7aef38c266126488e2fb2cd2fa))
* resolve assume-role via np API instead of CONTEXT.providers ([#14](https://github.com/nullplatform/services-s-3/issues/14)) ([038e51c](https://github.com/nullplatform/services-s-3/commit/038e51cbf898cf8c62d39064d47f7a9b856898ea))
* **s3:** grant s3:Get*/List* so provider refresh reads succeed ([#18](https://github.com/nullplatform/services-s-3/issues/18)) ([b06dac8](https://github.com/nullplatform/services-s-3/commit/b06dac82157e1a415b933b627742defcd69237f1))

## [0.1.1](https://github.com/nullplatform/services-s-3/compare/v0.1.0...v0.1.1) (2026-04-30)


### Bug Fixes

* propagate bucket_name/arn/region from build_context to link workflows ([05965dd](https://github.com/nullplatform/services-s-3/commit/05965dd5a53e1f2ddc334dfe170bc104de134679))
* propagate bucket_name/arn/region from build_context to link workflows ([043d173](https://github.com/nullplatform/services-s-3/commit/043d173bdbe87a440345fd2ca14c7731a101b44d))

## [0.1.0](https://github.com/nullplatform/services-s-3/compare/0.0.1...v0.1.0) (2026-04-17)


### Features

* add AWS S3 bucket service ([#1](https://github.com/nullplatform/services-s-3/issues/1)) ([1c98510](https://github.com/nullplatform/services-s-3/commit/1c98510a7fc8ff7bee924d4390ef69f00a6afd79))


### Bug Fixes

* stop duplicating bucket metadata on link env vars ([#4](https://github.com/nullplatform/services-s-3/issues/4)) ([f5c943e](https://github.com/nullplatform/services-s-3/commit/f5c943ee88fe461bab65a212f4180ad40843d605))
