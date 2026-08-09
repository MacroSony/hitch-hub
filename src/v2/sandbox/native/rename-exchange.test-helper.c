#define _GNU_SOURCE

#include <fcntl.h>
#include <linux/fs.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) return 2;
  unsigned long count = argc == 4 ? strtoul(argv[3], NULL, 10) : 1;
  if (count < 1 || count > 1000000) return 2;
  for (unsigned long index = 0; index < count; index++) {
    if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2],
                RENAME_EXCHANGE) != 0)
      return 1;
  }
  return 0;
}
