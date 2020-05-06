<p align="center">
  <a href="https://github.com/mjcheetham/update-homebrew/actions"><img alt="update-homebrew status" src="https://github.com/mjcheetham/update-homebrew/workflows/build-test/badge.svg"></a>
</p>

Update a Homebrew Formula or Cask from a workflow.

## Example

```yaml
- uses: mjcheetham/update-homebrew@v1
  with:
    token: ${{secrets.COMMIT_TOKEN}}
    name: my-formula
    version: 2.3.4
    sha256: e99fa5e39fa055c318300f65353c8256fca7cc25c16212c73da2081c5a3637f7
```
