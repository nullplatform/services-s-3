variable "nrn" {
  description = "NRN of your organization where the service is installed (e.g. organization=123:account=456). The package is looked up as visible there, installed there, and the agent channel is created there."
  type        = string
}

variable "visible_to" {
  description = "Where inside your organization the service can be used. Defaults to [nrn]. Every entry must be under your organization."
  type        = list(string)
  default     = null
}

variable "agent_tags_selectors" {
  description = "Tags that select the agent running this service (must match the agent's TAGS), e.g. { cluster = \"runtime\" }."
  type        = map(string)
}

variable "cluster_name" {
  description = "Name of the cluster where the agent runs. Used to name the IAM role and to derive the default agent role ARN."
  type        = string
}

variable "agent_role_arn" {
  description = "ARN of the agent's IAM role, trusted by the service's permissions role. Empty uses the conventional arn:aws:iam::<account>:role/nullplatform-<cluster_name>-agent-role."
  type        = string
  default     = ""
}

variable "additional_agent_role_arns" {
  description = "Extra IAM role ARNs allowed to assume the service's permissions role."
  type        = list(string)
  default     = []
}

variable "iam_create_role" {
  description = "Create the IAM permissions role. Set to false when your stack already manages it."
  type        = bool
  default     = true
}

variable "iam_role_name" {
  description = "Name of the IAM permissions role. Empty uses nullplatform_<cluster_name>_s3_role."
  type        = string
  default     = ""
}

variable "iam_policies_name_prefix" {
  description = "Prefix of the IAM policy names. Empty uses nullplatform_<cluster_name>."
  type        = string
  default     = ""
}

variable "iam_resource_tags" {
  description = "Tags added to every IAM resource."
  type        = map(string)
  default     = {}
}
