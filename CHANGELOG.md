# Changelog

## [0.2.0](https://github.com/nullplatform/services-s-3/compare/v0.1.1...v0.2.0) (2026-07-08)


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
