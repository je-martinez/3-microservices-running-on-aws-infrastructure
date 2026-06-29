variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "region" {
  description = "AWS region where the User Pool is created. Used to construct the issuer URL."
  type        = string
  default     = "us-east-1"
}

variable "password_minimum_length" {
  description = "Minimum password length enforced by the User Pool."
  type        = number
  default     = 8
}
