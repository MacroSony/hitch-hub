#define _GNU_SOURCE

#include <fcntl.h>
#include <inttypes.h>
#include <linux/memfd.h>
#include <linux/openat2.h>
#include <openssl/evp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define FRAME_MAGIC "HITCHB1\n"
#define FRAME_MAGIC_LENGTH 8
#define MAX_FRAME_BYTES 131072
#define MAX_MOUNTS 16
#define TARGET_FD_BASE 100

static void die(void) {
  fputs("secure sandbox launch rejected\n", stderr);
  _exit(125);
}

static void read_exact(int fd, void *output, size_t length) {
  uint8_t *cursor = output;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count <= 0) die();
    cursor += (size_t)count;
    length -= (size_t)count;
  }
}

static void write_exact(int fd, const void *input, size_t length) {
  const uint8_t *cursor = input;
  while (length > 0) {
    ssize_t count = write(fd, cursor, length);
    if (count <= 0) die();
    cursor += (size_t)count;
    length -= (size_t)count;
  }
}

static uint8_t hex_nibble(char value) {
  if (value >= '0' && value <= '9') return (uint8_t)(value - '0');
  if (value >= 'a' && value <= 'f') return (uint8_t)(value - 'a' + 10);
  die();
  return 0;
}

static char *decode_path(const char *hex) {
  size_t length = strlen(hex);
  if (length < 2 || length > 8192 || (length % 2) != 0) die();
  char *output = calloc(length / 2 + 1, 1);
  if (output == NULL) die();
  for (size_t index = 0; index < length; index += 2) {
    uint8_t value =
        (uint8_t)((hex_nibble(hex[index]) << 4) | hex_nibble(hex[index + 1]));
    if (value == 0) die();
    output[index / 2] = (char)value;
  }
  if (output[0] != '/') die();
  return output;
}

static void decode_digest(const char *hex, uint8_t output[32]) {
  if (strlen(hex) != 64) die();
  for (size_t index = 0; index < 32; index++) {
    output[index] = (uint8_t)((hex_nibble(hex[index * 2]) << 4) |
                              hex_nibble(hex[index * 2 + 1]));
  }
}

static int sealed_copy(int source_fd, const char *expected_hex,
                       uint64_t expected_size) {
  uint8_t expected_digest[32];
  decode_digest(expected_hex, expected_digest);
  int output_fd = (int)syscall(SYS_memfd_create, "hitch-reviewed-artifact",
                               MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (output_fd < 0) die();
  EVP_MD_CTX *digest = EVP_MD_CTX_new();
  if (digest == NULL || EVP_DigestInit_ex(digest, EVP_sha256(), NULL) != 1)
    die();
  uint8_t buffer[65536];
  uint64_t total = 0;
  for (;;) {
    ssize_t count = read(source_fd, buffer, sizeof(buffer));
    if (count < 0) die();
    if (count == 0) break;
    total += (uint64_t)count;
    if (total > expected_size ||
        EVP_DigestUpdate(digest, buffer, (size_t)count) != 1)
      die();
    write_exact(output_fd, buffer, (size_t)count);
  }
  uint8_t actual_digest[EVP_MAX_MD_SIZE];
  unsigned actual_length = 0;
  if (total != expected_size ||
      EVP_DigestFinal_ex(digest, actual_digest, &actual_length) != 1 ||
      actual_length != 32 || memcmp(actual_digest, expected_digest, 32) != 0)
    die();
  EVP_MD_CTX_free(digest);
  if (lseek(output_fd, 0, SEEK_SET) != 0 || fchmod(output_fd, 0444) != 0 ||
      fcntl(output_fd, F_ADD_SEALS,
            F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL) != 0)
    die();
  return output_fd;
}

int main(int argc, char **argv) {
  int discarded_stderr = open("/dev/null", O_WRONLY | O_CLOEXEC);
  if (discarded_stderr < 0 || dup2(discarded_stderr, STDERR_FILENO) < 0) _exit(125);
  close(discarded_stderr);
  if (argc < 2) die();
  uint8_t header[FRAME_MAGIC_LENGTH + 4];
  read_exact(STDIN_FILENO, header, sizeof(header));
  if (memcmp(header, FRAME_MAGIC, FRAME_MAGIC_LENGTH) != 0) die();
  uint32_t payload_length = ((uint32_t)header[8] << 24) |
                            ((uint32_t)header[9] << 16) |
                            ((uint32_t)header[10] << 8) | header[11];
  if (payload_length == 0 || payload_length > MAX_FRAME_BYTES) die();
  char *payload = calloc((size_t)payload_length + 1, 1);
  if (payload == NULL) die();
  read_exact(STDIN_FILENO, payload, payload_length);

  char *save = NULL;
  char *line = strtok_r(payload, "\n", &save);
  char nonce[65] = {0};
  unsigned count = 0;
  char extra = 0;
  if (line == NULL || sscanf(line, "%64[a-f0-9] %u %c", nonce, &count, &extra) !=
                          2 ||
      strlen(nonce) != 64 || count < 1 || count > MAX_MOUNTS)
    die();

  int root_fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (root_fd < 0) die();
  for (unsigned index = 0; index < count; index++) {
    line = strtok_r(NULL, "\n", &save);
    if (line == NULL) die();
    uint64_t expected_device = 0;
    uint64_t expected_inode = 0;
    uint64_t expected_links = 0;
    uint64_t expected_size = 0;
    unsigned expected_mode = 0;
    unsigned expected_uid = 0;
    unsigned expected_gid = 0;
    unsigned expected_directory = 0;
    unsigned expected_sealed = 0;
    char expected_digest[65] = {0};
    char hex_path[8193] = {0};
    if (sscanf(line,
               "%" SCNu64 " %" SCNu64 " %u %" SCNu64 " %u %u %" SCNu64
               " %u %u %64s %8192s %c",
               &expected_device, &expected_inode, &expected_mode,
               &expected_links, &expected_uid, &expected_gid, &expected_size,
               &expected_directory, &expected_sealed, expected_digest,
               hex_path, &extra) != 11 ||
        expected_directory > 1 || expected_sealed > 1 ||
        expected_directory == expected_sealed)
      die();
    char *path = decode_path(hex_path);
    struct open_how how = {
        .flags = expected_directory ? O_PATH | O_DIRECTORY | O_CLOEXEC
                                    : O_RDONLY | O_CLOEXEC,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                   RESOLVE_NO_MAGICLINKS,
    };
    int source_fd =
        (int)syscall(SYS_openat2, root_fd, path + 1, &how, sizeof(how));
    free(path);
    if (source_fd < 0) die();
    struct stat value;
    if (fstat(source_fd, &value) != 0 ||
        (uint64_t)value.st_dev != expected_device ||
        (uint64_t)value.st_ino != expected_inode ||
        (unsigned)value.st_mode != expected_mode ||
        (uint64_t)value.st_nlink != expected_links ||
        (unsigned)value.st_uid != expected_uid ||
        (unsigned)value.st_gid != expected_gid ||
        (uint64_t)value.st_size != expected_size ||
        (expected_directory ? !S_ISDIR(value.st_mode) : !S_ISREG(value.st_mode)))
      die();
    int mount_fd = source_fd;
    if (expected_sealed) {
      if (expected_links != 1 || (expected_mode & 0222) != 0) die();
      mount_fd = sealed_copy(source_fd, expected_digest, expected_size);
      close(source_fd);
    } else if (strcmp(expected_digest, "-") != 0) {
      die();
    }
    int target = TARGET_FD_BASE + (int)index;
    if (mount_fd != target) {
      if (dup2(mount_fd, target) != target) die();
      close(mount_fd);
    }
    if (fcntl(target, F_SETFD, 0) != 0) die();
  }
  if (strtok_r(NULL, "\n", &save) != NULL) die();
  close(root_fd);
  free(payload);

  char acknowledgement[96];
  int acknowledgement_length =
      snprintf(acknowledgement, sizeof(acknowledgement),
               "HITCH_BWRAP_HANDOFF_V1 %s %ld\n", nonce, (long)getpid());
  if (acknowledgement_length <= 0 ||
      (size_t)acknowledgement_length >= sizeof(acknowledgement))
    die();
  write_exact(STDOUT_FILENO, acknowledgement,
              (size_t)acknowledgement_length);
  uint8_t continue_byte = 0;
  read_exact(STDIN_FILENO, &continue_byte, 1);
  if (continue_byte != 0x47) die();
  execv("/usr/bin/bwrap", argv + 1);
  die();
}
